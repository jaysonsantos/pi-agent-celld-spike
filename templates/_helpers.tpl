{{/* The fixed name of each resource of this chart. One cluster holds one release, like OpenSandbox itself. */}}
{{- define "spike.name" -}}pi-agent-celld-spike{{- end }}

{{- define "spike.labels" -}}
app.kubernetes.io/name: {{ include "spike.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "spike.selectorLabels" -}}
app.kubernetes.io/name: {{ include "spike.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "spike.celldName" -}}{{ include "spike.name" . }}-celld{{- end }}
{{- define "spike.bucketUrl" -}}s3://{{ .Values.bucket.name }}/{{ .Values.bucket.prefix }}{{- end }}

{{/* Loopback addresses of the gateway sidecar. The worker and celld reach them inside the pod. */}}
{{- define "spike.s3ShimListen" -}}127.0.0.1:9000{{- end }}
{{- define "spike.proxyListen" -}}127.0.0.1:9100{{- end }}
{{- define "spike.proxyPort" -}}9100{{- end }}

{{/* In-cluster address of the OpenSandbox server. The subchart fixes the Service name and the port. */}}
{{- define "spike.sandboxServerUrl" -}}http://opensandbox-server.{{ .Values.namespace }}.svc.cluster.local{{- end }}

{{/*
The OpenSandbox subcharts take the namespace as a literal value, and the Secret and the ConfigMap that their
values name must match the resources of this chart. Stop when one of them is different.
*/}}
{{- define "spike.validate" -}}
{{- if ne .Release.Namespace .Values.namespace }}
{{- fail (printf "install this chart into the namespace %q (it is %q); see values.yaml" .Values.namespace .Release.Namespace) }}
{{- end }}
{{- range $chart := list "opensandbox-controller" "opensandbox-server" }}
{{- if ne (index $.Values $chart "namespaceOverride") $.Values.namespace }}
{{- fail (printf "%s.namespaceOverride must be %q" $chart $.Values.namespace) }}
{{- end }}
{{- end }}
{{- if ne .Values.secrets.name (include "spike.name" .) }}
{{- fail (printf "secrets.name must be %q, because opensandbox-server.server.env names that Secret" (include "spike.name" .)) }}
{{- end }}
{{- if or (not .Values.secrets.s3AccessKeyId) (not .Values.secrets.s3SecretAccessKey) }}
{{- fail "secrets.s3AccessKeyId and secrets.s3SecretAccessKey are necessary; scripts/install.sh passes them" }}
{{- end }}
{{- if not .Values.bucket.endpoint }}
{{- fail "bucket.endpoint is necessary: the URL of the S3-compatible object store; scripts/install.sh passes S3_ENDPOINT" }}
{{- end }}
{{- if and (ne .Values.llm.api "faux") (not .Values.llm.baseUrl) }}
{{- fail "llm.baseUrl is necessary when llm.api is not faux" }}
{{- end }}
{{- range $name, $feature := .Values.features }}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$" $name) }}
{{- fail (printf "feature name %q must be lower-case letters, digits, and hyphens, at most 50 characters" $name) }}
{{- end }}
{{- if or (not $feature.repo) (not $feature.task) }}
{{- fail (printf "feature %q needs repo and task" $name) }}
{{- end }}
{{- end }}
{{- end }}

{{/* The gateway sidecar: the S3 shim for celld, and the proxy that adds the keys of the model and of OpenSandbox. */}}
{{- define "spike.gatewayContainer" -}}
- name: gateway
  image: {{ .root.Values.images.node }}
  imagePullPolicy: {{ .root.Values.images.pullPolicy }}
  # A native sidecar: it starts before the main container and stops after it.
  restartPolicy: Always
  command: ["node", "/app/src/gateway/main.ts"]
  env:
    - name: GATEWAY_S3_LISTEN
      value: {{ include "spike.s3ShimListen" .root | quote }}
    - name: GATEWAY_S3_UPSTREAM
      value: {{ .root.Values.bucket.endpoint | quote }}
    - name: GATEWAY_PROXY_LISTEN
      value: {{ include "spike.proxyListen" .root | quote }}
    - name: AWS_ACCESS_KEY_ID
      valueFrom: { secretKeyRef: { name: {{ .root.Values.secrets.name }}, key: s3-access-key-id } }
    - name: AWS_SECRET_ACCESS_KEY
      valueFrom: { secretKeyRef: { name: {{ .root.Values.secrets.name }}, key: s3-secret-access-key } }
    {{- if .proxies }}
    - name: SANDBOX_BASE_URL
      value: {{ include "spike.sandboxServerUrl" .root | quote }}
    - name: SANDBOX_API_KEY
      valueFrom: { secretKeyRef: { name: {{ .root.Values.secrets.name }}, key: sandbox-api-key } }
    {{- if ne .root.Values.llm.api "faux" }}
    - name: LLM_BASE_URL
      value: {{ .root.Values.llm.baseUrl | quote }}
    - name: LLM_AUTH_HEADER
      value: {{ .root.Values.llm.authHeader | quote }}
    - name: LLM_AUTH_SCHEME
      value: {{ .root.Values.llm.authScheme | quote }}
    - name: LLM_API_KEY
      valueFrom: { secretKeyRef: { name: {{ .root.Values.secrets.name }}, key: llm-api-key } }
    {{- end }}
    {{- end }}
  startupProbe:
    exec:
      command:
        - node
        - --eval
        - {{ printf "fetch('http://%s/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" (include "spike.proxyListen" .root) | quote }}
    periodSeconds: 2
    failureThreshold: 60
  resources:
    {{- toYaml .root.Values.gateway.resources | nindent 4 }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: { drop: [ALL] }
    seccompProfile: { type: RuntimeDefault }
  volumeMounts:
    - name: gateway-source
      mountPath: /app/src/gateway
      readOnly: true
{{- end }}

{{- define "spike.gatewayVolume" -}}
- name: gateway-source
  configMap:
    name: {{ include "spike.name" . }}-gateway
{{- end }}

{{/* The sources that the deploy Job builds, as a map of file path to content. */}}
{{- define "spike.workerSourceFiles" -}}
{{- $files := dict }}
{{- range $path := list "package.json" "pnpm-lock.yaml" "pnpm-workspace.yaml" "wrangler.jsonc" }}
{{- $_ := set $files $path ($.Files.Get $path) }}
{{- end }}
{{- range $path, $_ := $.Files.Glob "src/worker/**" }}
{{- $_ := set $files $path ($.Files.Get $path) }}
{{- end }}
{{- range $path, $_ := $.Files.Glob "src/jobs/**" }}
{{- $_ := set $files $path ($.Files.Get $path) }}
{{- end }}
{{- toYaml $files }}
{{- end }}

{{/* A ConfigMap key cannot hold a slash, so a path becomes a key with a double underscore. */}}
{{- define "spike.sourceKey" -}}{{ . | replace "/" "__" }}{{- end }}

{{/* The `vars` of the worker. celld keeps them as plain text in the bucket, so no secret goes here. */}}
{{- define "spike.workerVars" -}}
{{- dict
  "GATEWAY_URL" (printf "http://%s" (include "spike.proxyListen" .))
  "LLM_API" .Values.llm.api
  "LLM_PROVIDER" .Values.llm.provider
  "LLM_MODEL" .Values.llm.model
  "LLM_CONTEXT_WINDOW" (.Values.llm.contextWindow | int64 | toString)
  "LLM_MAX_TOKENS" (.Values.llm.maxTokens | int64 | toString)
  "LLM_REASONING" (.Values.llm.reasoning | toString)
  "LLM_THINKING_LEVEL" .Values.llm.thinkingLevel
  "SANDBOX_IMAGE" .Values.sandbox.image
  "SANDBOX_ARCH" .Values.sandbox.arch
  "SANDBOX_CPU_LIMIT" (.Values.sandbox.resources.limits.cpu | toString)
  "SANDBOX_MEMORY_LIMIT" (.Values.sandbox.resources.limits.memory | toString)
  "SANDBOX_CPU_REQUEST" (.Values.sandbox.resources.requests.cpu | toString)
  "SANDBOX_MEMORY_REQUEST" (.Values.sandbox.resources.requests.memory | toString)
  "SANDBOX_WORKSPACE_STORAGE_CLASS" .Values.sandbox.workspace.storageClass
  "SANDBOX_WORKSPACE_SIZE" (.Values.sandbox.workspace.size | toString)
  "PIPELINE_MAX_ROUNDS" (.Values.pipeline.maxRounds | int64 | toString)
  "BUCKET_URL" (include "spike.bucketUrl" .)
  | toJson }}
{{- end }}

{{/*
The id of the worker deployment that this chart revision makes: a hash of each value that goes into the deploy Job.
A Job cannot change, so the Job name carries the id, and a new value thus makes a new Job. The worker also gets the
id as a var, and the submit Job sends it, so a feature never starts on the deployment of an older revision.
*/}}
{{- define "spike.deployId" -}}
{{- $sources := include "spike.workerSourceFiles" . }}
{{- $vars := include "spike.workerVars" . }}
{{- $script := .Files.Get "scripts/in-cluster/deploy-worker.sh" }}
{{- $spec := dict "images" .Values.images "bucket" .Values.bucket "affinity" .Values.nodeAffinity "deploy" .Values.deploy "gateway" .Values.gateway | toJson }}
{{- $gateway := (.Files.Glob "src/gateway/*.ts").AsConfig }}
{{- printf "%s%s%s%s%s" $sources $vars $script $spec $gateway | sha256sum | trunc 10 }}
{{- end }}

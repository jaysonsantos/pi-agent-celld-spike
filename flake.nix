{
  description = "Pi Durable on celld with OpenSandbox, as a Helm chart";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # The worker, the gateway sidecar, and their tests (src/, test/).
              nodejs_24
              pnpm

              # The chart and the cluster (Chart.yaml, templates/, scripts/install.sh).
              kubernetes-helm
              kubectl
              sops
              jq

              # The bucket, and the celld binary from its release image (scripts/fetch-celld.sh).
              awscli2
              crane

              # The hooks of .pre-commit-config.yaml.
              prek
              shellcheck
              typos
              nixfmt
              gitleaks
              editorconfig-checker
            ];
          };
        }
      );
    };
}

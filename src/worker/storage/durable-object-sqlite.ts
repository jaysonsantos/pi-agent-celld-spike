// SQLite storage of Pi Durable on the storage of one SQLite-backed Durable Object.
//
// Pi Durable 1.0.4 has no adapter for a Durable Object. Its repository has one that is not released yet
// (packages/durable/src/storage/sqlite/cloudflare.ts, MIT). This file is a port of that adapter. Remove it when a
// release exports `@earendil-works/pi-durable/storage/sqlite/cloudflare`.
import {
  type SqliteDatabase,
  type SqliteExecutor,
  SqliteStorage,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/** Values that the SQL binding of a Durable Object accepts and returns. */
type DurableObjectSqlValue = ArrayBuffer | string | number | null;

type DurableObjectSqlRow = Record<string, DurableObjectSqlValue>;

/** The parts of `ctx.storage` that this adapter uses. */
export interface DurableObjectSqliteStorage {
  readonly sql: {
    exec(query: string, ...bindings: DurableObjectSqlValue[]): { toArray(): DurableObjectSqlRow[] };
  };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

const INACTIVE_TRANSACTION_MESSAGE = "SQLite transaction handle is no longer active";

/** Runs operations one at a time in call order, so a transaction excludes each other operation. */
class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
}

/** The SQL binding takes a number as a double, so a `bigint` out of the safe range cannot keep its value. */
function bindValue(value: SqliteValue): DurableObjectSqlValue {
  if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
  if (typeof value !== "bigint") return value;
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
  }
  return Number(value);
}

function bind(params: readonly SqliteValue[]): DurableObjectSqlValue[] {
  return params.map(bindValue);
}

/** Changes each `BLOB` column to a `Uint8Array` in place. */
function typedRows<T>(rows: DurableObjectSqlRow[]): T[] {
  for (const row of rows) {
    for (const key in row) {
      const value = row[key];
      if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[key] = new Uint8Array(value);
    }
  }
  return rows as T[];
}

/** Runs SQL through `ctx.storage.sql`. Each cursor is read to its end, which celld needs before an outbound effect. */
class DurableObjectSqliteExecutor implements SqliteExecutor {
  protected readonly storage: DurableObjectSqliteStorage;

  constructor(storage: DurableObjectSqliteStorage) {
    this.storage = storage;
  }

  async exec(sql: string): Promise<void> {
    this.check();
    this.storage.sql.exec(sql).toArray();
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    this.check();
    this.storage.sql.exec(sql, ...bind(params)).toArray();
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    this.check();
    return typedRows<T>(this.storage.sql.exec(sql, ...bind(params)).toArray())[0];
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    this.check();
    return typedRows<T>(this.storage.sql.exec(sql, ...bind(params)).toArray());
  }

  /** Throws when this handle must not run SQL. */
  protected check(): void {}
}

/** The handle that a transaction callback gets. It is not valid after the callback settles. */
class DurableObjectSqliteTransaction extends DurableObjectSqliteExecutor {
  active = true;

  protected override check(): void {
    if (!this.active) throw new Error(INACTIVE_TRANSACTION_MESSAGE);
  }
}

/** `SqliteDatabase` on the SQLite storage of a Durable Object. An integer is a JavaScript number. */
export class DurableObjectSqliteDatabase extends DurableObjectSqliteExecutor implements SqliteDatabase {
  readonly #queue = new SerialQueue();

  override exec(sql: string): Promise<void> {
    return this.#queue.run(() => super.exec(sql));
  }

  override run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#queue.run(() => super.run(sql, ...params));
  }

  override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#queue.run(() => super.get<T>(sql, ...params));
  }

  override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#queue.run(() => super.all<T>(sql, ...params));
  }

  /** `ctx.storage.transaction()` commits when the callback resolves, and rolls back when it rejects. */
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#queue.run(() =>
      this.storage.transaction(async () => {
        const transaction = new DurableObjectSqliteTransaction(this.storage);
        try {
          return await callback(transaction);
        } finally {
          transaction.active = false;
        }
      }),
    );
  }

  /** Waits for the queued work. The Durable Object owns its storage, so there is nothing more to close. */
  close(): Promise<void> {
    return this.#queue.run(() => {});
  }
}

/** Opens the durable storage of Pi Durable on `ctx.storage` of a SQLite-backed Durable Object. */
export function openDurableObjectSqliteStorage(storage: DurableObjectSqliteStorage): Promise<SqliteStorage> {
  return SqliteStorage.open(new DurableObjectSqliteDatabase(storage));
}

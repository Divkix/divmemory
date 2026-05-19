declare module "bun:sqlite" {
	export class Database {
		constructor(filename: string);
		/**
		 * Executes an SQL statement with bound parameters.
		 * @param sql - The SQL statement to execute.
		 * @param args - The values to bind to the parameters.
		 */
		run(
			sql: string,
			...args: (string | number | null | undefined)[]
		): { changes: number; lastInsertRowId: number };
		/** Execute an SQL statement without returning results. */
		exec(sql: string): void;
		/** Compile and cache an SQL query for faster execution. */
		query(sql: string): {
			all<T = unknown>(...args: (string | number | null | undefined)[]): T[];
			get<T = unknown>(...args: (string | number | null | undefined)[]): T;
			values<T = unknown>(...args: (string | number | null | undefined)[]): T[];
		};
	}
}

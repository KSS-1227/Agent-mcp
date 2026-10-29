import dotenv from "dotenv";

export interface DotenvLoadOptions {
  path: string;
  quiet: true;
}

export type DotenvLoader = (options: DotenvLoadOptions) => unknown;

/** Called only by the direct application entrypoint, never by config imports. */
export function loadApplicationEnvironment(
  path: string,
  loader: DotenvLoader = (options) => dotenv.config(options)
): void {
  loader({ path, quiet: true });
}

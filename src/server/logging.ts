export interface ServerLogger {
  info(message: string): void;
  error(message: string): void;
}

export const DEFAULT_SERVER_LOGGER: ServerLogger = {
  info(message: string): void {
    console.log(message);
  },
  error(message: string): void {
    console.error(message);
  },
};

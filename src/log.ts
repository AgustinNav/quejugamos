// Structured JSON logs, one line per event. Cloud Logging maps `severity` and `message` natively.
// Never pass tokens here; player names are not logged either (only counts and ids).

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
export type Logger = (event: string, fields?: Record<string, unknown>, severity?: Severity) => void;

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  return (event, fields = {}, severity = 'INFO') => {
    write(JSON.stringify({ severity, message: event, event, time: new Date().toISOString(), ...fields }));
  };
}

export const silentLogger: Logger = () => {};

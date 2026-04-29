import log from 'electron-log/main';

let initialized = false;

export function initializeLogging(): void {
  if (initialized) return;
  initialized = true;

  log.initialize();
  log.transports.file.level = 'info';
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

  process.on('uncaughtException', (error) => {
    log.error('[uncaughtException]', error);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('[unhandledRejection]', reason);
  });

  log.info('Keptra main process logging initialized');
}

export { log };

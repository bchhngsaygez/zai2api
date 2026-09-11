import { EventEmitter } from 'events';

class LogManager extends EventEmitter {
  constructor(maxLogs = 500) {
    super();
    this.maxLogs = maxLogs;
    this.logs = [];
    this.initConsoleInterception();
  }

  initConsoleInterception() {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => {
      origLog(...args);
      this.addLog('info', args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    console.warn = (...args) => {
      origWarn(...args);
      this.addLog('warn', args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    console.error = (...args) => {
      origError(...args);
      this.addLog('error', args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
  }

  addLog(level, message) {
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    this.emit('log', entry);
    return entry;
  }

  getLogs(limit = 200) {
    return this.logs.slice(-limit);
  }

  clear() {
    this.logs = [];
    this.emit('clear');
  }
}

export const logger = new LogManager();

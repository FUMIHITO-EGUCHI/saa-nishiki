const CDP_PORT_ENV = 'SAA_CDP_PORT';
const CDP_PORT_ARGUMENT = '--saa-cdp-port=';
const MIN_CDP_PORT = 1024;
const MAX_CDP_PORT = 65535;

function parseCdpPort(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= MIN_CDP_PORT && value <= MAX_CDP_PORT
      ? value
      : null;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;

  const port = Number(value.trim());
  return Number.isInteger(port) && port >= MIN_CDP_PORT && port <= MAX_CDP_PORT
    ? port
    : null;
}

function getExplicitArgument(argv) {
  if (!Array.isArray(argv)) return undefined;

  const argument = argv.find((value) => typeof value === 'string' && value.startsWith(CDP_PORT_ARGUMENT));
  return argument === undefined ? undefined : argument.slice(CDP_PORT_ARGUMENT.length);
}

function getCdpConfiguration({ env = process.env, argv = process.argv } = {}) {
  const argumentValue = getExplicitArgument(argv);
  if (argumentValue !== undefined) {
    const port = parseCdpPort(argumentValue);
    return port === null
      ? { enabled: false, port: null, source: 'invalid' }
      : { enabled: true, port, source: 'command-line' };
  }

  const environmentValue = env && typeof env === 'object' ? env[CDP_PORT_ENV] : undefined;
  if (environmentValue === undefined || environmentValue === '') {
    return { enabled: false, port: null, source: 'disabled' };
  }

  const port = parseCdpPort(environmentValue);
  return port === null
    ? { enabled: false, port: null, source: 'invalid' }
    : { enabled: true, port, source: 'environment' };
}

function configureCdp(electronApp, options = {}) {
  const configuration = getCdpConfiguration(options);
  if (!configuration.enabled) return configuration;

  electronApp.commandLine.appendSwitch('remote-debugging-port', String(configuration.port));
  return configuration;
}

export {
  CDP_PORT_ENV,
  CDP_PORT_ARGUMENT,
  MAX_CDP_PORT,
  MIN_CDP_PORT,
  configureCdp,
  getCdpConfiguration,
  parseCdpPort,
};


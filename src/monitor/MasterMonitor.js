import { EventEmitter } from 'events';
import { ensureLogger, logger, setLoggers } from 'pot-logger';
import chalk from 'chalk';
import delay from 'delay';
import Connection from '../Connection';
import WorkerMonitor from './WorkerMonitor';
import workspace from '../utils/workspace';
import watch from '../utils/watch';
import onSignalExit from '../utils/onSignalExit';
import createScriptRunner from '../utils/createScriptRunner';
import { ENV_VAR_KEY } from '../utils/EnvVar';

export default class MasterMonitor extends EventEmitter {
	constructor(options) {
		super();

		const {
			instances,
			workspace: space,
			logsDir,
			execPath,
			spawnArgs,
			daemon,
			env,
			monitorProcessTitle,
			baseDir: cwd,
			production,
			name,
			events,
			watch: watchOptions,
			...respawnOptions
		} = (this._options = options);

		setLoggers({
			...options,
			enable: !daemon || logsDir,
			logsDir: logsDir || '.logs',
		});

		workspace.set(space);
		process.title = monitorProcessTitle;

		this._workerMonitorOptions = {

			// stdio: ['ignore', 'pipe', 'pipe'],
			...respawnOptions,
			execPath,
			execArgv: spawnArgs,
			data: options,
			env: (function () {
				const res = { ...env };
				if (!res.NODE_ENV) {
					res.NODE_ENV = production ? 'production' : 'development';
				}
				res[ENV_VAR_KEY] = JSON.stringify(options);
				return res;
			})(),
		};

		const eventsLogger = ensureLogger('events', 'gray');
		const runScript = createScriptRunner({ cwd, logger: eventsLogger });

		this._runEvent = (event, ...args) => {
			const hook = events[event];
			if (hook) {
				const prefix = [event]
					.concat(args)
					.filter(Boolean)
					.join(' ');
				eventsLogger.info(chalk.gray(`${prefix} - ${hook}`));
				runScript(event, ...args);
			}
		};

		this._count = 0;
		this._instances = instances;
		this.workerMonitors = [];

		const exit = async () => {
			logger.debug('exit');
			try {
				const connection = await Connection.getByName(name);
				if (connection) {
					await connection.requestStopServer();
				}
				await Promise.all(
					this.workerMonitors.map(async (monitor) => monitor.stop()),
				);
			}
			catch (err) {
				logger.debug(err);
			}
			process.exit();
		};

		process.on('uncaughtException', async (err) => {
			logger.fatal(err);
			await exit();
		});

		onSignalExit(async () => {
			setLoggers('logLevel', 'OFF');
			await exit();
		});

		watch({ cwd, ...watchOptions }, async () => {
			logger.trace('watch:restart');
			process.emit('watch:restart');
			const { length } = this.workerMonitors;
			const reloadDelay = length > 1 ? 2000 / length : 0;
			for (const workerMonitor of this.workerMonitors) {
				await workerMonitor.restart();
				await delay(reloadDelay);
			}
		});
	}

	async spawn(instances = this._instances) {
		const { EventTypes } = WorkerMonitor;
		const runEvent = this._runEvent;

		const workerMonitors = new Array(instances)
			.fill()
			.map(() => new WorkerMonitor(this._workerMonitorOptions));

		this.workerMonitors.push(...workerMonitors);

		const errors = [];

		const bootstraps = workerMonitors.map((workerMonitor) => {
			let displayName = workerMonitor.data.name;

			workerMonitor.on(EventTypes.STOP, () => {
				logger.warn(`"${displayName}" stopped`);
				runEvent(EventTypes.STOP);
			});

			workerMonitor.on(EventTypes.CRASH, () => {
				logger.fatal(`"${displayName}" crashed`);
				runEvent(EventTypes.CRASH);
			});

			workerMonitor.on(EventTypes.SLEEP, () => {
				logger.warn(`"${displayName}" sleeped`);
				runEvent(EventTypes.SLEEP);
			});

			workerMonitor.on(EventTypes.SPAWN, () => {
				runEvent(EventTypes.SPAWN);
			});

			workerMonitor.on(EventTypes.EXIT, async (code, signal) => {
				logger.debug(
					`"${displayName}" exit with code "${code}", signal "${signal}"`,
				);
				runEvent(EventTypes.EXIT, code, signal);
			});

			workerMonitor.on(EventTypes.STDOUT, (data) => {
				runEvent(EventTypes.STDOUT);
				logger.info(data.toString().trim());
			});

			workerMonitor.on(EventTypes.STDERR, (data) => {
				runEvent(EventTypes.STDERR);
				logger.error(data.toString().trim());
			});

			workerMonitor.on(EventTypes.WARN, (data) => {
				runEvent(EventTypes.WARN);
				logger.warn(data.toString().trim());
			});

			workerMonitor.on(EventTypes.RESTART, async () => {
				await Connection.writePid(workerMonitor);
				logger.info(`"${displayName}" restarted`);
				runEvent(EventTypes.RESTART);
			});

			return new Promise((resolve) => {
				workerMonitor.on(EventTypes.START, async () => {
					try {
						workerMonitor.id = ++this._count;
						await Connection.serve(this, workerMonitor);
						displayName = workerMonitor.data.displayName;
						logger.info(`"${displayName}" started`);
						runEvent(EventTypes.START);
					}
					catch (err) {
						logger.debug(err);
						errors.push(err);
					}
					resolve();
				});
				workerMonitor.start();
			});
		});

		await Promise.all(bootstraps);

		const ok = bootstraps.length > errors.length;
		return {
			ok,
			errors: errors.map(({ message, stack }) => ({
				message,
				stack,
			})),
		};
	}

	async scale(number) {
		const delta = number - this._count;
		if (!delta) {
			return { ok: true };
		}
		else if (delta > 0) {
			return this.spawn(delta);
		}
		else {
			const { workerMonitors } = this;
			const removes = workerMonitors.slice(workerMonitors.length + delta);
			try {
				await Promise.all(
					removes.map((workerMonitor) => this.requestShutDown(workerMonitor)),
				);
				return { ok: true };
			}
			catch (error) {
				return { ok: false, error };
			}
		}
	}

	async state(workerMonitor, newState) {
		if (newState) {
			Object.assign(workerMonitor.data, newState);
		}
		return workerMonitor.toJSON();
	}

	async restart(workerMonitor) {
		return workerMonitor.restart();
	}

	async requestShutDown(workerMonitor, options) {
		await Connection.shutDown(this, workerMonitor, options);
	}
}
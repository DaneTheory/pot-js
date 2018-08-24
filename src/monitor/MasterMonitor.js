import { EventEmitter } from 'events';
import { ensureLogger, logger, setLoggers } from 'pot-logger';
import chalk from 'chalk';
import delay from 'delay';
import WorkerMonitor from './WorkerMonitor';
import workspace from '../utils/workspace';
import watch from '../utils/watch';
import onceSignalExit from '../utils/onceSignalExit';
import createScriptRunner from '../utils/createScriptRunner';
import EventTypes from '../constants/EventTypes';
import { ENV_VAR_KEY } from '../utils/EnvVar';
import Errors from '../utils/Errors';
import ensureInstanceNumber from '../utils/ensureInstanceNumber';
import getInstanceDisplayName from '../utils/getInstanceDisplayName';
import { getPidFile, writePid, removePidFile } from '../utils/PidHelpers';
import {
	startServer,
	getSocketPath,
	removeDomainSocket,
} from '../utils/SocketsHelpers';

export default class MasterMonitor extends EventEmitter {
	constructor(options) {
		super();

		const {
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
		} = options;

		setLoggers({
			...options,
			enable: !daemon || logsDir,
			logsDir: logsDir || '.logs',
		});

		workspace.set(space);
		process.title = monitorProcessTitle;

		this.socket = null;

		this._workerMonitorOptions = {
			stdio: 'pipe',
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

		this.workerMonitors = [];

		const exit = async () => {
			try {
				await this.shutDown();
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

		onceSignalExit(async () => {
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

	async spawn(options = {}) {
		const newInstances = ensureInstanceNumber(options.instances);
		const runEvent = this._runEvent;

		const workerMonitors = new Array(newInstances)
			.fill()
			.map(() => new WorkerMonitor(this._workerMonitorOptions));

		const errors = new Errors();

		if (!this.socket) {
			const name = this._workerMonitorOptions.data.name;
			const socketPath = await getSocketPath(name);
			this.socket = await startServer(this, socketPath);
		}

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
				await writePid(workerMonitor.data);
				logger.info(`"${displayName}" restarted`);
				runEvent(EventTypes.RESTART);
			});

			return new Promise((resolve) => {
				workerMonitor.on(EventTypes.START, async () => {
					try {
						const { workerMonitors } = this;
						const numbers = workerMonitors.length ?
							workerMonitors.map((wm) => wm.instanceNum) :
							[0];
						workerMonitor.instanceNum = Math.max(...numbers) + 1;
						workerMonitors.push(workerMonitor);

						const { data: options, instanceNum } = workerMonitor;
						workspace.set(options);

						const { name } = options;
						const pidFile = await getPidFile(name, instanceNum);
						const socketPath = await getSocketPath(name);

						options.instanceNum = instanceNum;
						options.pidFile = pidFile;
						options.socketPath = socketPath;
						options.displayName = getInstanceDisplayName(
							options.name,
							instanceNum,
						);

						await writePid(options);

						workerMonitors.sort((a, b) => a.instanceNum - b.instanceNum);

						displayName = workerMonitor.data.displayName;
						logger.info(`"${displayName}" started`);
						runEvent(EventTypes.START);
					}
					catch (err) {
						logger.debug(err);
						errors.push(err);
					}
					resolve(workerMonitor.toJSON());
				});
				workerMonitor.start();
			});
		});

		const added = await Promise.all(bootstraps);

		const ok = bootstraps.length > errors.length;
		return {
			ok,
			errors: errors.toJSON(),
			added,
		};
	}

	async scale(number) {
		const size = ensureInstanceNumber(number);
		const delta = size - this.workerMonitors.length;
		if (!delta) {
			return { ok: true, errors: [] };
		}
		else if (delta > 0) {
			const res = await this.spawn({ instances: delta });
			return res;
		}
		else {
			const { workerMonitors } = this;
			const toRemove = workerMonitors.slice(workerMonitors.length + delta);
			const errors = new Errors();
			const removed = await Promise.all(
				toRemove.map(async (workerMonitor) => {
					const state = workerMonitor.toJSON();
					await this.shutDown(workerMonitor.instanceNum).catch((err) =>
						errors.push(err),
					);
					return state;
				}),
			);
			return {
				ok: !errors.length,
				errors: errors.toJSON(),
				removed,
			};
		}
	}

	async state(newState) {
		return {
			stateList: this.workerMonitors.map((workerMonitor) => {
				if (newState) {
					Object.assign(workerMonitor.data, newState);
				}
				return workerMonitor.toJSON();
			}),
		};
	}

	async restart(instanceNum) {
		if (!instanceNum && instanceNum !== 0) {
			await Promise.all(
				this.workerMonitors.map(async (workerMonitor) => {
					await workerMonitor.restart();
				}),
			);
			return this.workerMonitors.length;
		}
		else {
			const workerMonitor = this.workerMonitors.find(
				(workerMonitor) => workerMonitor.instanceNum === instanceNum,
			);
			if (workerMonitor) {
				await workerMonitor.restart();
				return 1;
			}
			return 0;
		}
	}

	async shutDown(instanceNum) {
		if (!instanceNum && instanceNum !== 0) {
			return Promise.all(
				this.workerMonitors.map((workerMonitor) =>
					this.shutDown(workerMonitor.instanceNum),
				),
			);
		}

		const workerMonitor = this.workerMonitors.find(
			(workerMonitor) => workerMonitor.instanceNum === instanceNum,
		);

		if (!workerMonitor) {
			logger.warn(`Can not stop instance number "${instanceNum}"`);
			return;
		}

		await workerMonitor.stop();
		const { socketPath, pidFile } = workerMonitor.toJSON();

		const { workerMonitors } = this;
		const index = workerMonitors.indexOf(workerMonitor);
		workerMonitors.splice(index, 1);
		await removePidFile(pidFile);

		if (!workerMonitors.length) {
			removeDomainSocket(socketPath);
			if (this.socket) {
				await new Promise((resolve, reject) => {
					this.socket.close((err) => {
						if (err) reject(err);
						else resolve();
					});
				});
			}
			process.exit(0);
		}
	}
}

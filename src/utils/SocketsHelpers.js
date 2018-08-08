import { remove } from 'fs-extra';
import { basename, join } from 'path';
import workspace from './workspace';
import { createServer, createClient } from './ipc';
import { ensureLocalDomainPath } from 'create-local-domain-socket';
import { logger } from 'pot-logger';
import chalk from 'chalk';
import globby from 'globby';
import { noop, isObject, isFunction } from 'lodash';
import isWin from './isWin';
import getKey from './getKey';
import { REQUEST, PUBLISH } from './SocketEventTypes';

export async function getSocketFiles() {
	const runDir = await workspace.getRunDir();

	// DEPRECATED: workspace.DEPRECATED_getSocketsDir()
	const deprecatedSocketsDir = await workspace.DEPRECATED_getSocketsDir();

	const patterns = [`${runDir}/**/*.sock`, `${deprecatedSocketsDir}/**/*`];

	const socketPaths = await globby(patterns, {
		absolute: true,
		expandDirectories: false,
		onlyFiles: false,
	});

	return socketPaths.map((socketPath) => ({
		socketPath,
		key: basename(socketPath, '.sock'),
	}));
}

export async function removeDomainSocketFile(socketPath) {
	if (isWin) {
		return;
	}
	if (isObject(socketPath)) {
		socketPath = socketPath.socketPath;
	}
	logger.trace('remove socket file', socketPath);
	return remove(socketPath).catch(noop);
}

export async function getSocketPath(keyOrMonitor) {
	const runDir = await workspace.getRunDir();
	const key = getKey(keyOrMonitor);
	return ensureLocalDomainPath(join(runDir, key) + '.sock');
}

export async function startServer(masterMonitor, workerMonitor) {
	const { socketPath } = workerMonitor.data;

	logger.trace('unix domain socket path', chalk.gray(socketPath));
	await createServer(socketPath, (socket) => {
		const createListener = (event) => {
			socket.data(event, async (data) => {
				if (!data || !data.method) return;

				const { args = [], method } = data;
				try {
					masterMonitor.currentWorkerMonitor = workerMonitor;
					if (isFunction(masterMonitor[method])) {
						const resp = await masterMonitor[method](...args);
						if (event === REQUEST) {
							socket.send(method, resp);
						}
					}
					else {
						logger.warn(
							`Received API call "${method}", but it's not supported`,
						);
					}
				}
				catch (err) {
					logger.error(`Failed to handle API call "${method}".`, err);
				}
			});
		};
		createListener(REQUEST);
		createListener(PUBLISH);
	});
}

export async function startClient(socketPath, options = {}) {
	const { silence } = options;

	try {
		const clientSocket = await createClient(socketPath);
		silence || logger.trace('start client socket', socketPath);
		return clientSocket;
	}
	catch (err) {
		if (err && ~['ECONNRESET', 'ECONNREFUSED', 'ENOENT'].indexOf(err.code)) {
			await removeDomainSocketFile(socketPath);
		}
		else {
			silence || logger.error('socket error', err);
		}
	}
}

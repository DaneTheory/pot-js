import getInfoVerbose from './getInfoVerbose';
import { RESTART, SCALE, STATE } from '../utils/SocketEventTypes';
import { getPids } from '../utils/PidHelpers';
import { logger } from 'pot-logger';
import {
	getSocketFiles,
	startClient,
	getSocketPath,
	removeDomainSocketFile,
} from '../utils/SocketsHelpers';
import { differenceWith, noop } from 'lodash';
import isWin from '../utils/isWin';
import workspace from '../utils/workspace';

const getState = async function getState(socket, ...args) {
	try {
		const state = await socket.request(STATE, ...args);

		// DEPRECATED: adapt to old version state
		if (state && state.data) {
			const { data } = state;
			delete state.data;
			state.monitor = state;
			Object.assign(state, data);
			if (state.parentPid && !state.ppid) state.ppid = state.parentPid;
		}

		return state;
	}
	catch (err) {
		socket.close().catch(noop);
		return null;
	}
};

const getAll = async function getAll() {
	const pidRefs = await getPids();
	const socketRefs = await getSocketFiles();

	const refsList = [];
	await Promise.all(
		pidRefs.map(async ({ pid, key, pidFile }) => {
			const socketPath = await getSocketPath(key);
			const socket = await startClient(socketPath);
			if (socket) {
				refsList.push({ key, socket, pid, pidFile, socketPath });
			}
			else {
				removeDomainSocketFile(socketPath);
			}
		}),
	);

	// remove zombie socket files
	if (!isWin) {
		await Promise.all(
			differenceWith(
				socketRefs,
				pidRefs,
				(socketRef, pidRef) => socketRef.key === pidRef.key,
			).map(async (socketRef) => {
				const socket = await startClient(socketRef.socketPath);
				if (socket) {
					const state = await getState(socket);
					if (state) {
						const { pidFile, pid } = state;
						refsList.push({
							pidFile,
							pid,
							...socketRef,
							socket,
						});
					}
				}
			}),
		);
	}
	return refsList;
};

const getByName = async function getByName(name) {
	const refsList = await getAll();
	const res = [];
	await Promise.all(
		refsList.map(async (ref) => {
			const { socket } = ref;
			const state = await getState(socket);
			if (state) {
				if (name === state.name) {
					res.push(ref);
				}
				else {
					await socket.close();
				}
			}
		}),
	);
	return res;
};

const getByKey = async function getByKey(key) {
	const refsList = await getAll();
	let res;
	await Promise.all(
		refsList.map(async (ref) => {
			const { socket } = ref;
			const state = await getState(socket);
			if (state) {
				if (key === state.key) {
					res = ref;
				}
				else {
					await socket.close();
				}
			}
		}),
	);
	return res;
};

export default class Instance {
	static async getAllInstances(options) {
		workspace.set(options);
		const refs = await getAll();
		return refs.map((ref) => new Instance(ref, options));
	}

	static async getInstanceByKey(key, options) {
		workspace.set(options);
		const refs = await getByKey(key);
		return refs.map((ref) => new Instance(ref, options));
	}

	static async getInstancesByName(name, options) {
		workspace.set(options);
		const refs = await getByName(name);
		return refs.map((ref) => new Instance(ref, options));
	}

	constructor({ socket }, options = {}) {
		this._keepAlive = options.keepAlive;
		this._socket = socket;
	}

	async _response(res) {
		let response;
		if (res) response = await res;
		if (!this._keepAlive) this.disconnect();
		return response;
	}

	async _getState(...args) {
		const state = await getState(this._socket, ...args);
		return this._response(state);
	}

	async setState(state) {
		return this._getState(state);
	}

	async getState() {
		return this._getState();
	}

	async getInfo() {
		return this.getState();
	}

	async getInfoVerbose() {
		const state = await this.getState();
		return getInfoVerbose(state);
	}

	async restart() {
		return this._response(this._socket.request(RESTART));
	}

	async scale(number) {
		return this._response(this._socket.request(SCALE, number));
	}

	async disconnect() {
		try {
			await this._socket.close();
		}
		catch (err) {
			logger.debug(err);
		}
	}

	async requestStopServer(options) {
		return this._response(this._socket.requestClose(options));
	}
}

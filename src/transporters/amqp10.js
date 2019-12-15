/*
 * moleculer
 * Copyright (c) 2019 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const url = require("url");
const Promise = require("bluebird");
const Transporter = require("./base");
const { isPromise } = require("../utils");

const {
	PACKET_REQUEST,
	PACKET_RESPONSE,
	PACKET_UNKNOWN,
	PACKET_EVENT,
	PACKET_DISCOVER,
	PACKET_INFO,
	PACKET_DISCONNECT,
	PACKET_HEARTBEAT,
	PACKET_PING,
	PACKET_PONG
} = require("../packets");

/**
 * Transporter for AMQP 1.0
 *
 * More info: https://www.amqp.org/resources/specifications
 *
 * @class Amqp10Transporter
 * @extends {Transporter}
 */
class Amqp10Transporter extends Transporter {
	/**
	 * Creates an instance of Amqp10Transporter.
	 *
	 * @param {any} opts
	 *
	 * @memberof Amqp10Transporter
	 */
	constructor(opts) {
		if (typeof opts == "string") opts = { url: opts };

		super(opts);

		if (!this.opts) this.opts = {};

		this.receivers = [];
		this.hasBuiltInBalancer = true;
		this.messages = {};
	}

	_getQueueOptions(packetType, balancedQueue) {
		let packetOptions = {};
		switch (packetType) {
			// Requests and responses don't expire.
			case PACKET_REQUEST:
				packetOptions = this.opts.autoDeleteQueues && !balancedQueue ? { dynamic: this.opts.autoDeleteQueues } : {};
				break;
			case PACKET_RESPONSE:
				packetOptions = this.opts.autoDeleteQueues ? { dynamic: this.opts.autoDeleteQueues } : {};
				break;

			// Consumers can decide how long events live
			// Load-balanced/grouped events
			case PACKET_EVENT + "LB":
			case PACKET_EVENT:
				packetOptions = this.opts.autoDeleteQueues ? { dynamic: this.opts.autoDeleteQueues } : {};
				break;

			// Packet types meant for internal use
			case PACKET_HEARTBEAT:
				packetOptions = { autoDelete: true };
				break;
			case PACKET_DISCOVER:
			case PACKET_DISCONNECT:
			case PACKET_UNKNOWN:
			case PACKET_INFO:
			case PACKET_PING:
			case PACKET_PONG:
				packetOptions = { dynamic: true };
				break;
		}

		return Object.assign(packetOptions, this.opts.queueOptions);
	}

	_getMessageOptions(packetType, balancedQueue) {
		let messageOptions = {};
		switch (packetType) {
			case PACKET_REQUEST:
			case PACKET_RESPONSE:
				break;
			case PACKET_EVENT + "LB":
			case PACKET_EVENT:
				if (this.opts.eventTimeToLive) messageOptions.ttl = this.opts.eventTimeToLive;
				break;
			case PACKET_HEARTBEAT:
				if (this.opts.heartbeatTimeToLive) messageOptions.ttl = this.opts.heartbeatTimeToLive;
				break;
			case PACKET_DISCOVER:
			case PACKET_DISCONNECT:
			case PACKET_UNKNOWN:
			case PACKET_INFO:
			case PACKET_PING:
			case PACKET_PONG:
				break;
		}

		return Object.assign(messageOptions, this.opts.messageOptions);
	}

	/**
	 * Build a function to handle requests.
	 *
	 * @param {String} cmd
	 * @param {Boolean} needAck
	 *
	 * @memberof AmqpTransporter
	 */
	_consumeCB(cmd, needAck = false) {
		return ({ message, delivery }) => {
			const result = this.incomingMessage(cmd, message.body);

			if (needAck) {
				const messageId = this.uuid();
				this.messages[messageId] = { delivery, message };
				console.log("GOT -", cmd, messageId);

				(messageId => {
					if (isPromise(result)) {
						return result
							.then(() => {
								if (this.connection) {
									delivery.update(true);
									delivery.accept();
									console.log("ACK -", cmd, messageId);
									if (this.messages[messageId]) {
										delete this.messages[messageId];
									}
								}
							})
							.catch(err => {
								this.logger.error("Message handling error.", err);
								if (this.connection) {
									// delivery.settled = false;
									delivery.reject();
									if (this.messages[messageId]) {
										delete this.messages[messageId];
									}
								}
							});
					} else {
						if (this.connection) {
							// delivery.settled = true;

							delivery.accept();
							if (this.messages[messageId]) {
								delete this.messages[messageId];
							}
						}
					}
				})(messageId);
			}

			return result;
		};
	}

	/**
	 * Connect to a AMQP 1.0 server
	 *
	 * @memberof Amqp10Transporter
	 */
	async connect(errorCallback) {
		let rhea;

		try {
			rhea = require("rhea-promise");
		} catch (err) {
			/* istanbul ignore next */
			this.broker.fatal(
				"The 'rhea-promise' package is missing. Please install it with 'npm install rhea-promise --save' command.",
				err,
				true
			);
		}

		if (!rhea) {
			this.broker.fatal("Missing rhea package", new Error("Missing rhea package"), true);
		}

		// Pick url
		const uri = this.opts.url;
		const urlParsed = url.parse(uri);
		const connectionOptions = {
			host: urlParsed.hostname,
			hostname: urlParsed.hostname,
			username: "admin",
			password: "admin",
			port: urlParsed.port,
			container_id: rhea.generate_uuid()
		};

		this.uuid = rhea.generate_uuid;

		const container = new rhea.Container();
		const connection = container.createConnection(connectionOptions);
		try {
			this.connection = await connection.open();
			this.session = await this.connection.createSession();
			this.session.setMaxListeners(30);
			this.logger.info("AMQP10 is connected.");
			this.connected = true;
			await this.onConnected();
		} catch (e) {
			this.logger.info("AMQP10 is disconnected.");
			this.connected = false;

			if (e) {
				this.logger.error(e);
			}
		}
	}

	/**
	 * Disconnect from an AMQP10 server
	 *
	 * @memberof Amqp10Transporter
	 */
	async disconnect() {
		try {
			if (this.connection) {
				console.log(`DISCONNECTING WITH ${Object.keys(this.messages).length} MESSAGES IN QUEUE`);
				for (const receiver of this.receivers) {
					await receiver.close();
				}
				for (const key of Object.keys(this.messages)) {
					this.messages[key].delivery.update(false);
					this.messages[key].delivery.reject();
					delete this.messages[key];
					console.log("DELETED", key);
				}
				await this.connection.close();
				console.log("CLOSED");
				this.connection = null;
				this.receivers = [];
			}
		} catch (error) {
			this.logger.error(error);
		}
	}

	async subscribe(cmd, nodeID) {
		if (!this.session) return;

		const topic = this.getTopicName(cmd, nodeID);
		let receiverOptions = Object.assign({}, this._getQueueOptions(cmd), {
			session: this.session,
			onSessionError: context => {
				const sessionError = context.session && context.session.error;
				if (sessionError) {
					this.logger.error(
						">>>>> [%s] An error occurred for session of receiver '%s': %O.",
						this.connection.id,
						topic,
						sessionError
					);
				}
			}
		});

		if (nodeID) {
			const needAck = [PACKET_REQUEST].indexOf(cmd) !== -1;
			Object.assign(receiverOptions, {
				autoaccept: false,
				name: topic,
				source: {
					address: topic
				}
			});

			const receiver = await this.connection.createReceiver(receiverOptions);
			receiver.on("message", context => {
				this._consumeCB(cmd, needAck)(context);
			});
			receiver.on("receiver_error", context => {
				const receiverError = context.receiver && context.receiver.error;

				if (receiverError) {
					this.logger.error(">>>>> [%s] An error occurred for receiver '%s': %O.", this.connection.id, topic, receiverError);
				}
			});

			this.receivers.push(receiver);
		} else {
			const topicName = "Consumer." + this.nodeID + ".VirtualTopic." + topic;
			Object.assign(receiverOptions, {
				name: topicName,
				source: {
					address: topicName
				}
			});
			const receiver = await this.connection.createReceiver(receiverOptions);

			receiver.on("message", context => {
				this._consumeCB(cmd, false)(context);
			});
			receiver.on("receiver_error", context => {
				const receiverError = context.receiver && context.receiver.error;

				if (receiverError) {
					this.logger.error(">>>>> [%s] An error occurred for receiver '%s': %O.", this.connection.id, topic, receiverError);
				}
			});

			this.receivers.push(receiver);
		}
	}

	/**
	 * Subscribe to balanced action commands
	 *
	 * @param {String} action
	 * @memberof AmqpTransporter
	 */
	async subscribeBalancedRequest(action) {
		const queue = `${this.prefix}.${PACKET_REQUEST}B.${action}`;
		const receiverOptions = Object.assign(
			{},
			{
				source: { address: queue },
				autoaccept: false,
				rcv_settle_mode: 1
			},
			this._getQueueOptions(PACKET_REQUEST, true),
			{
				session: this.session,
				onSessionError: context => {
					const sessionError = context.session && context.session.error;
					if (sessionError) {
						this.logger.error(
							">>>>> [%s] An error occurred for session of receiver '%s': %O.",
							this.connection.id,
							queue,
							sessionError
						);
					}
				}
			}
		);
		const receiver = await this.connection.createReceiver(receiverOptions);
		receiver.on("message", this._consumeCB(PACKET_REQUEST, true));
		receiver.on("receiver_error", context => {
			const receiverError = context.receiver && context.receiver.error;

			if (receiverError) {
				this.logger.error(">>>>> [%s] An error occurred for receiver '%s': %O.", this.connection.id, queue, receiverError);
			}
		});

		this.receivers.push(receiver);
	}

	/**
	 * Subscribe to balanced event command
	 *
	 * @param {String} event
	 * @param {String} group
	 * @memberof AmqpTransporter
	 */
	async subscribeBalancedEvent(event, group) {
		const queue = `${this.prefix}.${PACKET_EVENT}B.${group}.${event}`;
		const receiverOptions = Object.assign({}, { source: { address: queue } }, this._getQueueOptions(PACKET_EVENT + "LB", true), {
			session: this.session,
			onSessionError: context => {
				const sessionError = context.session && context.session.error;
				if (sessionError) {
					this.logger.error(
						">>>>> [%s] An error occurred for session of receiver '%s': %O.",
						this.connection.id,
						queue,
						sessionError
					);
				}
			}
		});
		const receiver = await this.connection.createReceiver(receiverOptions);
		receiver.on("message", this._consumeCB(PACKET_EVENT, true));
		receiver.on("receiver_error", context => {
			const receiverError = context.receiver && context.receiver.error;

			if (receiverError) {
				this.logger.error(">>>>> [%s] An error occurred for receiver '%s': %O.", this.connection.id, queue, receiverError);
			}
		});

		this.receivers.push(receiver);
	}

	/**
	 * Publish a packet
	 *
	 * @param {Packet} packet
	 *
	 * @memberof Amqp10Transporter
	 * @description Send packets to their intended queues / exchanges.
	 *
	 * Reasonings documented in the subscribe method.
	 */
	async publish(packet) {
		/* istanbul ignore next*/
		if (!this.connection) return;

		let topic = this.getTopicName(packet.type, packet.target);

		const data = this.serialize(packet);
		const message = Object.assign({ body: data }, this._getMessageOptions(packet.type));
		const awaitableSenderOptions = {
			target: {
				address: packet.target ? topic : "topic://VirtualTopic." + topic
			}
		};
		try {
			const sender = await this.connection.createAwaitableSender(awaitableSenderOptions);
			await sender.send(message);
			this.incStatSent(data.length);
		} catch (error) {
			this.logger.error(error);
		}
	}

	/**
	 * Publish a balanced EVENT packet to a balanced queue
	 *
	 * @param {Packet} packet
	 * @param {String} group
	 * @returns {Promise}
	 * @memberof Amqp10Transporter
	 */
	async publishBalancedEvent(packet, group) {
		/* istanbul ignore next*/
		if (!this.connection) return;

		let queue = `${this.prefix}.${PACKET_EVENT}B.${group}.${packet.payload.event}`;
		const data = this.serialize(packet);
		const message = Object.assign({ body: data }, this.opts.messageOptions);
		const awaitableSenderOptions = {
			target: {
				address: queue
			}
		};
		try {
			const sender = await this.connection.createAwaitableSender(awaitableSenderOptions);
			await sender.send(message);
			this.incStatSent(data.length);
			await sender.close();
		} catch (error) {
			this.logger.error(error);
		}
	}

	/**
	 * Publish a balanced REQ packet to a balanced queue
	 *
	 * @param {Packet} packet
	 * @returns {Promise}
	 * @memberof AmqpTransporter
	 */
	async publishBalancedRequest(packet) {
		/* istanbul ignore next*/
		if (!this.connection) return Promise.resolve();

		const topic = `${this.prefix}.${PACKET_REQUEST}B.${packet.payload.action}`;

		const data = this.serialize(packet);
		const message = Object.assign({ body: data }, this.opts.messageOptions);
		const awaitableSenderOptions = {
			target: {
				address: topic
			}
		};
		try {
			const sender = await this.connection.createAwaitableSender(awaitableSenderOptions);

			const delivery = await sender.send(message);
			const { remote_settled, remote_state, sent, settled, id, state } = delivery;
			console.log(
				"publishBalancedRequest =======> \n",
				"remote_settled",
				remote_settled,
				"remote_state",
				remote_state,
				"sent",
				sent,
				"settled",
				settled,
				"id",
				id,
				"state",
				state
			);
			this.incStatSent(data.length);

			await sender.close();
		} catch (error) {
			this.logger.error(error);
		}
	}
}

module.exports = Amqp10Transporter;

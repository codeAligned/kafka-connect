"use strict";

const Promise = require("bluebird");
const { Consumer } = require("sinek");

const Config = require("./../common/Config.js");
const SinkBaseConverter = require("./SinkBaseConverter.js");
const SinkRecord = require("./SinkRecord.js");

/**
 * starts consume process from kafka topic to datastore table
 */
class SinkConfig extends Config {

    constructor(config, Connector, Task, Converters = [], consumer = null) {

        if (Converters.length <= 0) {
            Converters.unshift(SinkBaseConverter);
        }

        super(config, Connector, Task, Converters);
        this.config = config;

        this.maxRetries = this.config.maxRetries || 3;
        this.awaitRetry = this.config.awaitRetry || 10;

        this.consumer = consumer;
        this.connector = null;
        this.task = null;
    }

    run() {
        super.run();

        if (typeof this.config !== "object") {
            throw new Error("config must be a valid object.");
        }

        if (typeof this.config.kafka !== "object") {
            throw new Error("config.kafka must be a valid object.");
        }

        if (typeof this.config.connector !== "object") {
            throw new Error("config.connector must be a valid object.");
        }

        /*
         config = {
             kafka: {},
             topic: "topic",
             partitions: 30,
             maxTasks: 1,
             connector: {},
             maxRetries: 3,
             awaitRetry: 10,
             waitOnError: false,
             haltOnError: false
         }
         */

        this.consumer = this.consumer ||
            new Consumer(this.config.topic, this.config.kafka);

        return this.consumer.connect().then(() => {
            return new Promise((resolve, reject) => {

                this.connector = new this.Connector();
                this.connector.start(this.config.connector, error => {

                    if (error) {
                        return reject(error);
                    }

                    this.connector.taskConfigs(this.config.maxTasks, (error, taskConfig) => {

                        if (error) {
                            return reject(error);
                        }

                        this.task = new this.Task();
                        this.task.start(taskConfig, () => {

                            this.consumer.consume((_message, callback) => {

                                super.convertTo(_message, (error, message) => {

                                    if (error) {
                                        return super.emit("error", error);
                                    }

                                    this._putMessage(SinkConfig._messageToRecord(message), callback);
                                });
                            }).catch(error => super.emit("error", error));
                            resolve();
                        });
                    });
                });
            });
        });
    }

    static _messageToRecord(message) {

        //check if a converter has already turned this message into a record
        if (message && typeof message.value === "object" &&
            message instanceof SinkRecord) {
            return message;
        }

        try {
            const record = new SinkRecord();

            record.kafkaOffset = message.offset;
            record.key = message.key;
            record.partition = message.partition;

            record.keySchema = message.value.keySchema;
            record.timestamp = message.value.timestamp;
            record.value = message.value.value;
            record.valueSchema = message.value.valueSchema;

            return record;
        } catch (error) {
            super.emit("error", "Failed to turn message into SinkRecord: " + error.message);
            return message;
        }
    }

    _putMessage(message, callback, attempts = 0) {
        attempts++;

        try {
            this.task.put([message], error => {

                if (error) {
                    return this._onPutFail(error, message, callback, attempts);
                }

                callback(null);
            });
        } catch (error) {
            this._onPutFail(error, message, callback, attempts);
        }
    }

    _onPutFail(error, message, callback, attempts) {
        super.emit("error", error);

        if (attempts > this.maxRetries) {

            if (this.config.haltOnError) {
                super.emit("error", new Error("halting because of retry error."));
                return this.stop();
            }

            if (this.config.waitOnError) {
                super.emit("error", new Error("waiting because of retry error."));
                return; //never calls callback
            }

            return callback(error);
        }

        setTimeout(() => {
            this._putMessage(message, callback, attempts);
        }, this.awaitRetry);
    }

    stop(shouldCommit = false) {
        clearInterval(this._intv);
        this.consumer.close(shouldCommit);
        this.consumer = null;
        this.task.stop();
        this.connector.stop();
    }
}

module.exports = SinkConfig;
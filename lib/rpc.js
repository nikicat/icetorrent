const {Logged} = require('./log');
const {Class} = require('heritage');

const Rpc = Class({
    implements: [Logged],
    name: 'rpc',

    initialize: function() {
        this.handlers = {};
        this.tag = 'rpc';
    },

    onMessage: function(message) {
        this.debug('request: '+JSON.stringify(message));

        let response = {};
        try {
            //this.debug(this.handlers[message.method]);
            response.arguments = this.handlers[message.method](message.arguments);
            response.result = 'success';
        } catch (e) {
            this.error('error while handling '+message.method+': '+e);
            console.exception(e);
            response.result = e;
        }
        response.tag = message.tag;
        this.debug('response: '+JSON.stringify(response));
        return response;
    },

    on: function(method, handler) {
        this.debug('registering handler for '+method);
        this.handlers[method] = handler;
    }
});

exports.Rpc = Rpc;
exports.rpc = Rpc();

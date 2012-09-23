const {Server} = require('./net');
const {Logged} = require('./log');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {Class} = require('heritage');

const Listener = Class({
    implements: [Logged, EventTarget],
    name: 'Listener',
    initialize: function() {
        this.port = 6881 + Math.floor(10*Math.random());
        this.tag = this.port;
        this.server = new Server();
        this.server.on('connection', (function(conn) {
            emit(this, 'newpeer', conn);
        }).bind(this));
    },
    start: function() {
        this.server.listen(this.port);
    }
});

exports.Listener = Listener;

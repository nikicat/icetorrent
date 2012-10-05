var callbacks = [];
var tag = 0;

console.info('attached');

function rpc(method, arguments, callback) {
    var mytag = tag++;
    callbacks[mytag] = callback;
    self.port.emit('message', {
        method: method,
        arguments: arguments,
        tag: mytag
    });
}

window.wrappedJSObject.rpc = rpc;

self.port.on('message', function(message) {
    //console.info('message: '+JSON.stringify(message));
    var callback = callbacks[message.tag];
    delete callbacks[message.tag];
    callback(message);
});



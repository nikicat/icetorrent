let window = require("window-utils").activeBrowserWindow;
 
exports.atob = function(a) {
    return window.atob(a);
}
 
exports.btoa = function(b) {
    return window.btoa(b);
}
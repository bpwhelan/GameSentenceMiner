// A connecting ws socket emits an asynchronous error when closed. Retain a
// shutdown error handler after removing reconnect/message listeners so this
// expected cancellation cannot terminate the desktop service.
function closeWebSocket(socket) {
  if (!socket) return;
  socket.removeAllListeners();
  socket.on('error', () => {});
  socket.once('close', () => socket.removeAllListeners());
  socket.close();
}
module.exports = {closeWebSocket};

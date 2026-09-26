// Thin wrapper around Socket.IO so services can push events without importing
// the server. Every authenticated socket joins the room `user:<id>`.
let io = null;

export function setIo(instance) { io = instance; }
export function getIo() { return io; }

export function emitToUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

export function emitToAdmins(event, payload) {
  if (io) io.to('admins').emit(event, payload);
}

export function isUserOnline(userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return !!room && room.size > 0;
}

export function emitAll(event, payload) {
  if (io) io.emit(event, payload);
}

// Holds the Socket.IO instance so routes/services can emit without circular imports.
let io = null;
export const setIO = (instance) => { io = instance; };
export const emitTo = (room, event, payload) => { if (io) io.to(room).emit(event, payload); };

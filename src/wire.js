// UltiMafia socket framing.
//
// UM does NOT use socket.io. It uses raw WebSockets with a hand-rolled text
// frame: `eventName:typeofData:payload`. A frame with no payload is just the
// bare event name (this is how the "p" heartbeat works). Mirrors
// react_main/src/Socket.js and lib/sockets.js in the UM source.

export function stringifyMessage(eventName, data) {
  const type = typeof data;

  if (type === "undefined") return eventName;
  if (type === "object") data = JSON.stringify(data);
  else if (type !== "string") data = String(data);

  return `${eventName}:${type}:${data}`;
}

export function parseMessage(message) {
  // The `/:(.*)/s` split is deliberate: it splits on the FIRST colon only, so
  // colons inside the payload survive.
  let split = String(message).split(/:(.*)/s);
  const eventName = split[0];

  if (split.length < 2) return [eventName, undefined];

  split = split[1].split(/:(.*)/s);
  if (split.length < 2) return [eventName, undefined];

  const type = split[0];
  let data = split[1];

  switch (type) {
    case "number":
      data = Number(data);
      break;
    case "boolean":
      data = data !== "false";
      break;
    case "object":
      try {
        data = JSON.parse(data);
      } catch {
        return [eventName, undefined];
      }
      break;
  }

  return [eventName, data];
}

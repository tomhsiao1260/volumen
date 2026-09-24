export const SERVER_API_ENDPOINT = "http://localhost:3005";

/*
 * The same server, under its other name, for reading the scan through.  A browser opens six
 * connections to a host and no more, and a card's chunks fill all six for seconds at a time — behind
 * which the board's own saving waits, sometimes long enough to be overtaken by the next page load,
 * which then puts the old board back.  `localhost` and `127.0.0.1` are one server but two hosts to
 * the browser, so the data has six connections of its own and the board keeps the other six.
 */
export const SERVER_DATA_ENDPOINT = SERVER_API_ENDPOINT.includes("localhost")
  ? SERVER_API_ENDPOINT.replace("localhost", "127.0.0.1")
  : SERVER_API_ENDPOINT.replace("127.0.0.1", "localhost");

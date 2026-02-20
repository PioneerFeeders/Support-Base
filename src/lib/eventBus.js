// In-memory SSE event bus
// Keeps track of connected clients and broadcasts events to all of them

const clients = new Set();

function addClient(res) {
  clients.add(res);
  console.log(`SSE client connected. Total: ${clients.size}`);

  res.on('close', () => {
    clients.delete(res);
    console.log(`SSE client disconnected. Total: ${clients.size}`);
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  console.log(`SSE broadcast: ${event} to ${clients.size} client(s)`);

  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      console.error('SSE write error, removing client:', err.message);
      clients.delete(client);
    }
  }
}

function getClientCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, getClientCount };

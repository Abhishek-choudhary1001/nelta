
// Convenience exportable safeNetworkRun helper
export async function safeNetworkRun(network, runMessages, context) {
    if (!network) throw new Error('network is undefined');
    if (typeof network.run === 'function') return await network.run(runMessages, context);
    if (network.model && typeof network.model.run === 'function') return await network.model.run(runMessages, context);
    if (Array.isArray(network.agents) && network.agents[0] && network.agents[0].model && typeof network.agents[0].model.run === 'function') {
      return await network.agents[0].model.run(runMessages, context);
    }
    if (typeof network.request === 'function') return await network.request(runMessages, context);
    throw new Error('No runnable model found on network object');
  }
  
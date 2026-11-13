const os = require('os');

function getLocalIpAddresses() {
  const ifaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!iface.address.startsWith('169.254.')) {
          addresses.push({
            interface: name,
            address: iface.address
          });
        }
      }
    }
  }

  // Prioritize typical local subnet ranges (192.168.x, 10.x, 172.x)
  addresses.sort((a, b) => {
    const score = (ip) => {
      if (ip.startsWith('192.168.')) return 3;
      if (ip.startsWith('10.')) return 2;
      if (ip.startsWith('172.')) return 1;
      return 0;
    };
    return score(b.address) - score(a.address);
  });

  return addresses;
}

module.exports = {
  getLocalIpAddresses
};

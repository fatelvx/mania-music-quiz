// Multiplayer network config.
//
// Some networks (mobile carrier NAT, school/dorm/company Wi-Fi) block direct WebRTC connections.
// A TURN relay fixes that. Only small game messages go through it (music and charts load
// directly from osu!), so a free tier is plenty.
//
// Metered (https://www.metered.ca/stun-turn): create a free TURN app, then paste the
// "credentials API" URL here, e.g.
//   https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=XXXXXXXX
window.MMQ_CONFIG = {
  turnCredentialsUrl: '',
  // or static entries: { urls: ['turn:host:3478'], username: '...', credential: '...' }
  extraIceServers: [],
};

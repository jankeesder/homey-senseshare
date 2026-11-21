Your Homey already knows how warm, humid or dusty it is outside. SenseShare shares those readings as open data on openSenseMap, the citizen science map for environmental data. No extra hardware needed.

Why join?
- Put your neighbourhood on the map: many areas still have no measuring station at all.
- Open data that schools, researchers and municipalities use for lessons, studies and policy.
- No extra hardware: you use the sensors you already have in Homey.
- Free measurement history, and compare your readings with stations nearby on the map.
- A better picture for everyone: the more stations, the more reliable local data becomes.

How it works
1. Create a free account and a senseBox on opensensemap.org, with a sensor for every reading you want to share.
2. In Homey, add a senseBox device, sign in, choose your senseBox and pick which Homey device provides each reading.
3. SenseShare sends the current readings every 5 minutes (adjustable), also when a value did not change, so the graph on the map gets one point per interval.

Good to know
- Only outdoor sensors are useful. Indoor readings give the wrong picture on the map.
- Units are converted where possible, for example mbar to Pa or km/h to m/s.
- The location of your senseBox is public. You can choose a less precise location on opensensemap.org, for example the middle of your street.
- Placement matters: in the shade, out of the rain, at least a metre from walls and roofs.
- Flow cards: upload now, send any value (for example a Logic variable) to a sensor, and a trigger when an upload fails.
- Requires Homey Pro or Homey Self-Hosted Server: the app reads your other devices through the Homey Web API.

SenseShare is an independent app. It is not made by or affiliated with openSenseMap or senseBox.

# SenseShare

Homey-app (Apps SDK v3) die de metingen van je bestaande Homey-apparaten als open data naar [openSenseMap](https://opensensemap.org) stuurt. Elke senseBox op openSenseMap wordt een apparaat in Homey. Per sensor van de box kies je welk Homey-apparaat de waarde levert.

- App-id: `nl.senseshare` (aanpassen: zie [Naam en id wijzigen](#naam-en-id-wijzigen))
- Platform: Homey Pro en Homey Self-Hosted Server (`platforms: ["local"]`)
- Permissie: `homey:manager:api` (om andere apparaten uit te lezen)

## Waarom meedoen?

- **Je buurt in beeld.** Veel wijken hebben nog geen enkel meetstation. Jouw metingen vullen dat gat.
- **Open data die echt gebruikt wordt.** Scholen, onderzoekers en gemeenten gebruiken openSenseMap voor lessen, onderzoek en beleid, bijvoorbeeld rond hitte en luchtkwaliteit.
- **Geen extra hardware nodig.** Je gebruikt de sensoren die al in je Homey zitten.
- **Gratis meetgeschiedenis en vergelijken op de kaart.** openSenseMap bewaart je metingen en laat ze zien naast die van stations in de buurt.
- **Een beter beeld voor iedereen.** Hoe meer stations, hoe betrouwbaarder de lokale gegevens.

### Why join?

- **Put your neighbourhood on the map.** Many areas still have no measuring station at all. Your readings fill that gap.
- **Open data that is actually used.** Schools, researchers and municipalities use openSenseMap for lessons, studies and policy, for example on heat and air quality.
- **No extra hardware needed.** You use the sensors you already have in Homey.
- **Free measurement history and comparison on the map.** openSenseMap keeps your readings and shows them next to stations nearby.
- **A better picture for everyone.** The more stations, the more reliable local data becomes.

### Voordat je begint / Before you start

- **Alleen buitensensoren zijn zinvol.** Binnenmetingen (woonkamer, serre, schuur) geven een verkeerd beeld op de kaart. *Only outdoor sensors are useful.*
- **De locatie van je senseBox is openbaar.** Kies op opensensemap.org eventueel een grovere locatie, bijvoorbeeld het midden van je straat of een kruispunt in de buurt. *The location of your senseBox is public; you can choose a less precise one.*
- **Goede plaatsing is belangrijk.** Hang een temperatuursensor in de schaduw, uit de regen, op 1,5 à 2 meter hoogte en minstens een meter van muren, daken en warmtebronnen. Een sensor in de zon of tegen een muur meet al snel enkele graden te warm. *Placement matters: shade, out of the rain, away from walls.*

## Gebruik

### 1. Een senseBox aanmaken op openSenseMap

1. Maak een gratis account op [opensensemap.org](https://opensensemap.org).
2. Maak een nieuwe senseBox aan. Kies bij hardware **"Eigenbau"/zelfbouw** (geen senseBox-kit) en voeg per meting die je wilt delen een sensor toe, met titel, eenheid en sensortype. Bijvoorbeeld: Temperatuur `°C`, Luchtvochtigheid `%`, Luchtdruk `hPa`, PM2.5 `µg/m³`.
3. Zet de box op **buiten** (exposure: outdoor) en kies een locatie (zie hierboven).

### 2. Toevoegen in Homey

1. Apparaat toevoegen → SenseShare → senseBox.
2. Log in met je openSenseMap-e-mailadres (of gebruikersnaam) en wachtwoord. De login wordt meteen gecontroleerd; je krijgt een duidelijke melding bij een verkeerd wachtwoord of als openSenseMap niet bereikbaar is.
3. Kies één of meer senseBoxen (naam en id worden getoond).
4. Koppel in het scherm **Sensoren koppelen** elke sensor aan een Homey-apparaat en een capability, bijvoorbeeld *Weerstation – Temperatuur (measure_temperature)*. Laat een sensor leeg om hem over te slaan.
   - Per sensor zie je alleen meetwaarden (`measure_*`, `meter_*`) waarvan de eenheid past: dezelfde eenheid, of een eenheid die de app kan omrekenen. Met **Toon alle meetwaarden** zie je alles, bijvoorbeeld voor een apparaat zonder eenheid.
   - Rekent de app om, dan staat er bijvoorbeeld *"Wordt omgerekend van mbar naar Pa."*. Bij eenheden die niet om te rekenen zijn, zie je een waarschuwing. Je kunt de koppeling dan toch opslaan.
   - Kies bij luchtdruk de **stationsdruk** als je apparaat die heeft (niet de druk op zeeniveau): senseBoxen op openSenseMap sturen de druk zoals die ter plekke gemeten wordt.

### 3. Instellingen per apparaat

| Instelling | Standaard | Uitleg |
|---|---|---|
| Automatisch uploaden | aan | Uit = niets versturen per interval. De Flow-kaarten blijven werken. |
| Uploadinterval | 5 min | Minimaal 1 minuut. |

### 4. Koppelingen wijzigen, sensorlijst verversen, opnieuw inloggen

Open het apparaat → instellingen → **Repareren**. Je komt in hetzelfde koppelscherm, met de knoppen:

- **Sensorlijst opnieuw ophalen**: nadat je op opensensemap.org sensoren hebt toegevoegd of verwijderd.
- **Opnieuw inloggen**: als de login verlopen is, of om een ander account te gebruiken.

### 5. Flow-kaarten

| Type | Kaart | |
|---|---|---|
| Actie | Upload nu naar openSenseMap | Verstuurt meteen de actuele waarden van alle gekoppelde sensoren. |
| Actie | Stuur waarde [getal] naar sensor [sensor] | Verstuurt een willekeurig getal (bijv. een Logica-variabele) als meting, met het huidige tijdstip. De sensor kies je uit de sensoren van de box. |
| Trigger | Upload mislukt | Met tag **Foutmelding**. Gaat één keer af per mislukte upload, na eventuele nieuwe pogingen. |

### 6. Op het apparaat

- **Laatste upload**: tijdstip van de laatste geslaagde upload.
- **Mislukte uploads**: teller van mislukte uploads sinds het toevoegen.

## Hoe het werkt

- Elke interval leest de app via de Homey Web API (`homey-api`, `HomeyAPI.createAppAPI`) de gekoppelde capabilities en stuurt alle nieuwe waarden in **één** request naar `POST /boxes/{boxId}/data`.
- **Eenheden** worden omgerekend naar de eenheid van de openSenseMap-sensor als beide eenheden bekend zijn en dezelfde grootheid meten: luchtdruk (Pa, hPa/mbar, kPa, bar, mmHg, inHg), temperatuur (°C, °F, K), snelheid (m/s, km/h, mph, knopen, ft/s), lengte/neerslag (mm, cm, m, inch) en concentratie (ng/m³, µg/m³, mg/m³). Omgerekende waarden worden afgerond op 7 significante cijfers. Waarden die via de Flow-kaart *Stuur waarde* binnenkomen, worden niet omgerekend.
- `createdAt` is het `lastUpdated`-tijdstip van de capability, in UTC. Een tijdstip in de toekomst (klok van Homey loopt voor) wordt teruggezet naar "nu", omdat openSenseMap dat anders weigert.
- **Alleen nieuwe metingen**: een meting wordt alleen verstuurd als `lastUpdated` is veranderd sinds de vorige keer. Zo komen er geen dubbele punten op de kaart.
- **Overgeslagen** worden: lege (`null`) en niet-numerieke waarden, apparaten die niet beschikbaar zijn, verwijderde apparaten/capabilities en metingen ouder dan 1 uur.
- openSenseMap weigert de **hele** batch als één meting ongeldig is. Daarom controleert de app alles vooraf.
- **Netwerkfouten en 5xx**: tot 3 nieuwe pogingen met backoff (30 s, 60 s, 120 s, met wat spreiding), maar nooit voorbij het volgende interval. Wat niet lukt, blijft in de wachtrij en gaat mee met de volgende upload. Metingen ouder dan 1 uur worden weggegooid.
- **Inloggen en tokens**:
  - Voor het versturen van metingen is alleen de **access token van de box** nodig. Die geeft openSenseMap mee bij het ophalen van je boxen. Hij gaat als kale waarde in de `Authorization`-header, zonder "Bearer".
  - Het account-JWT (1 uur geldig) en de refresh token (1 week geldig) zijn alleen nodig voor koppelen, de sensorlijst verversen en het ophalen van een nieuwe access token. Ze worden automatisch ververst.
  - openSenseMap staat maar **één geldige refresh token per account** toe: elke nieuwe login (ook op de website) maakt de vorige ongeldig. Daarom bewaart de app de tokens **per account** in de app-instellingen (niet per apparaat), zodat meerdere senseBoxen van hetzelfde account elkaar niet uitloggen. Verversen gebeurt één keer tegelijk per account.
  - Het **wachtwoord wordt niet opgeslagen** en nooit gelogd. Verloopt de login, dan gaat uploaden gewoon door met de access token van de box. Pas als openSenseMap die access token weigert (bijvoorbeeld omdat je hem op de website opnieuw hebt gegenereerd) en de login niet meer te verversen is, gaat het apparaat op *niet beschikbaar* met de melding om via Repareren opnieuw in te loggen.
- Rate limits: openSenseMap heeft in de API (v11.3.0) geen rate limiting. De app stuurt per box maximaal één request per interval (minimaal 1 minuut), plus eventuele nieuwe pogingen. Een `429` wordt gerespecteerd (`Retry-After`).

## Bekende beperkingen

- **Alleen Homey Pro / Self-Hosted Server.** De app gebruikt `homey:manager:api`; dat is niet toegestaan op Homey Cloud. Apps met deze permissie worden in de App Store strenger beoordeeld; motiveer bij het indienen dat het uitlezen van andere apparaten de kernfunctie is.
- **De wachtrij staat in het geheugen.** Herstart de app terwijl uploads mislukken, dan gaan de nog niet verstuurde metingen (maximaal een uur) verloren.
- **Waarden die niet veranderen.** Als een apparaat dezelfde waarde blijft melden zonder dat `lastUpdated` verandert, wordt er niets nieuws verstuurd. openSenseMap kan die sensor dan als inactief tonen.
- **Sensoren die minder dan eens per uur melden**, worden overgeslagen (meting ouder dan 1 uur).
- **Omrekenen kan alleen binnen dezelfde grootheid** (zie hierboven). Koppel je bijvoorbeeld lux aan een sensor in W/m², dan krijg je een waarschuwing en gaat de waarde ongewijzigd door.
- **De boxselectie uit het lijstscherm** wordt doorgegeven via het (ongedocumenteerde) `list_devices_selection`-event. Werkt dat op een toekomstige Homey-versie niet meer, dan toont het koppelscherm alle boxen met een vinkje "Deze senseBox toevoegen".
- **De teller "Mislukte uploads"** loopt alleen op; hij wordt niet automatisch teruggezet.
- **Gedeelde boxen** (sharedBoxes) worden ook getoond. Als openSenseMap daarvoor geen access token meegeeft en de box authenticatie vereist, lukt uploaden niet.

## Ontwikkelen

Vereist: Node.js 22 of nieuwer (zoals op Homey) en de Homey CLI. De unit tests draaien ook op Node 20.

```bash
npm install
```

```bash
npm test
```

```bash
homey app validate --level publish
```

```bash
homey app run
```

- De tests gebruiken de ingebouwde test runner van Node (`node --test`). Alle HTTP-verkeer gaat via een nep-`fetch`. `test/helpers/no-network.js` blokkeert daarnaast elke echte netwerkverbinding, zodat er in tests nooit data naar openSenseMap gaat.
- `homey app run` installeert de app tijdelijk op je Homey (verdwijnt na Ctrl+C). `homey app install` installeert hem blijvend.
- Afbeeldingen opnieuw maken: `python3 scripts/generate-images.py` (Pillow).

### Projectstructuur

```
.homeycompose/            app-manifest en eigen capabilities (last_upload, upload_failures)
app.js                    App: openSenseMap-client, accountbeheer, homey-api
drivers/sensebox/
  driver.js               pairing, repair en Flow-kaarten
  device.js               uploadcyclus, retries, capabilities
  pair/koppelen.html      koppelscherm (pairing én repair)
  driver.*.compose.json   driver, instellingen, Flow-kaarten
lib/
  OpenSenseMapClient.js   API-client zonder Homey-afhankelijkheden
  AccountManager.js       één token-sessie per account, verversen
  measurements.js         payload opbouwen en ongeldige waarden overslaan
  UploadQueue.js          wachtrij (max. 1 uur) en backoff
  BoxUploader.js          één uploadpoging per box
  homeyDevices.js         Homey-apparaten en capabilities uitlezen
  units.js                eenheden vergelijken
locales/                  Nederlands en Engels
test/                     unit tests
```

### Naam en id wijzigen

De naam en het id staan in `.homeycompose/app.json` en in een paar teksten. Wijzig ze in één keer met:

```bash
npm run rename -- nl.mijnnaam.senseshare "Mijn Naam"
```

Alleen de naam: `npm run rename -- --name "Nieuwe naam"`. Draai daarna `homey app validate` om `app.json` opnieuw te genereren. In de code wordt het id nergens hard gebruikt (`this.homey.manifest.id`).

## Merknaam

SenseShare is een onafhankelijke app. "openSenseMap" en "senseBox" verwijzen alleen naar het platform en de boxen daarop; de app is niet gemaakt door en niet verbonden aan het openSenseMap- of senseBox-project.

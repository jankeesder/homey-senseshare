Je Homey weet al hoe warm, vochtig of stoffig het buiten is. SenseShare deelt die metingen als open data op openSenseMap, de burgerwetenschapskaart voor milieudata. Extra hardware is niet nodig.

Waarom meedoen?
- Zet je buurt in beeld: veel wijken hebben nog helemaal geen meetstation.
- Open data die scholen, onderzoekers en gemeenten gebruiken voor lessen, onderzoek en beleid.
- Geen extra hardware: je gebruikt de sensoren die al in je Homey zitten.
- Gratis meetgeschiedenis, en op de kaart vergelijk je je metingen met stations in de buurt.
- Een beter beeld voor iedereen: hoe meer stations, hoe betrouwbaarder de lokale gegevens.

Zo werkt het
1. Maak op opensensemap.org een gratis account en een senseBox aan, met een sensor voor elke meting die je wilt delen.
2. Voeg in Homey een senseBox-apparaat toe, log in, kies je senseBox en geef per meting aan welk Homey-apparaat de waarde levert.
3. SenseShare verstuurt de actuele metingen elke 5 minuten (instelbaar). Alleen nieuwe metingen worden verstuurd.

Goed om te weten
- Alleen buitensensoren zijn zinvol. Binnenmetingen geven een verkeerd beeld op de kaart.
- De locatie van je senseBox is openbaar. Op opensensemap.org kun je een minder precieze locatie kiezen, bijvoorbeeld het midden van je straat.
- Een goede plaatsing is belangrijk: in de schaduw, uit de regen, minstens een meter van muren en daken.
- Flow-kaarten: nu uploaden, een willekeurige waarde (bijvoorbeeld een Logica-variabele) naar een sensor sturen, en een trigger als een upload mislukt.
- Werkt op Homey Pro en Homey Self-Hosted Server: de app leest je andere apparaten uit via de Homey Web API.

SenseShare is een onafhankelijke app. De app is niet gemaakt door en niet verbonden aan openSenseMap of senseBox.

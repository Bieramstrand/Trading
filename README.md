# Wick Trading

Eine Seite für Day Trading mit Papiergeld, gebaut aus den trader Skills:
Scanner, Einstieg über die Eröffnungsspanne, Stopp und Ziel, Zeitmaschine
(10.000 Durchläufe), Positionsgröße, Risiko Prüfung, Papierdepot, Alarme,
News, Quartalszahlen und Kongress Meldungen.

## Aufbau

| Datei | Zweck |
| --- | --- |
| `index.html` | die Seite |
| `trading-engine.js` | alle Regeln, ohne Netzwerk, auch in Node testbar |
| `netlify/functions/market-chart.js` | Kerzen und Kurse von Yahoo Finance |
| `netlify/functions/market-news.js` | Schlagzeilen (Yahoo) und SEC Meldungen |
| `netlify/functions/sec-facts.js` | Quartalszahlen aus den SEC Daten |
| `netlify/functions/congress-trades.js` | Meldungen von Abgeordneten (House Clerk) |

## Netlify

Repo in Netlify verbinden, fertig. Für SEC Meldungen und Quartalszahlen
die Umgebungsvariable `SEC_USER_AGENT` setzen, zum Beispiel
`Max Mustermann max@example.com`. Die SEC verlangt Name und Mailadresse.

Nur Papiergeld. Bildung und Werkzeug, keine Anlageberatung.

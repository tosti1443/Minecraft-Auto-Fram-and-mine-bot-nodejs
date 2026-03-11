# Panel botow Minecraft na Raspberry Pi 4

Aplikacja webowa do zarzadzania botami Minecraft:
- dodawanie/usuwanie botow
- connect/disconnect pojedynczo i grupowo
- zmiana nazwy bota
- podglad statusu, koordynatow i ekwipunku
- miner z ochrona kilofow (min durability)
- kopanie obszaru, chunka lub zaznaczonych pol na mapie

## Zakladka Miner (mapa)
- top-down mapa z lotu ptaka
- `Surface map = TAK` (domyslnie) pokazuje prawdziwa powierzchnie terenu
- zaznaczanie kliknieciem pol do kopania
- granice chunkow widoczne bialymi liniami

## Auto skrzynka
Gdy EQ jest prawie pelny:
- jesli podasz `Chest X/Y/Z`, bot odnosi itemy tam
- jesli nie podasz i bot ma w EQ `chest`, postawi automatycznie skrzynke w rogu obszaru i odlozy itemy

## Wymagania
- Node.js 18+
- Serwer Minecraft Java dostepny z Raspberry Pi

## Instalacja
```bash
npm install
```

## Start
```bash
npm start
```

Panel:
- `http://localhost:3000`
- lub `http://IP_RASPBERRY_PI:3000`

## Uwaga o wersji 1.21.11
W Mineflayer czesto dziala oznaczenie `1.21.1`. Jesli `1.21.11` nie dziala, ustaw `1.21.1`.

/* ---------------------------- Мультиплеер: синхронизация через Firebase ---------------------------- */
// ВНИМАНИЕ следующему ИИ: это MVP-синхронизация, НЕ полноценный netcode.
// Мы пишем состояние юнитов/зданий локального игрока в RTDB с троттлингом,
// и подписываемся на комнату, чтобы отрисовывать юнитов/здания оппонента.
// Нет: интерполяции движения, разрешения конфликтов, защиты от читов,
// авторитетного сервера. См. футер файла — это прямой пункт для доработки.

// ИИ №35: БАГФИКС — roomRef/myPlayerRef раньше были const, вычислялись
// ОДИН РАЗ при загрузке этого <script> (странице только открылась, roomId
// в этот момент ещё "default-room" или значение из ?room=). Экран выбора
// режима (js/18-pvp-multiplayer.js) меняет глобальную roomId на "pvp-XXX"
// ПОЗЖЕ — асинхронно, по клику пользователя, уже после того как все
// скрипты загрузились. Из-за const это переприсваивание roomId никак не
// влияло на уже вычисленные roomRef/myPlayerRef — оба клиента реально
// синкались в один и тот же дефолтный room независимо от введённого кода
// комнаты (сам код был чисто косметическим полем ввода). Это была
// ГЛАВНАЯ причина, по которой PvP не работал как задумано: без общего
// изолированного room два случайных посетителя сайта либо не видели друг
// друга (если у каждого был свой ?room=), либо видели ЛЮБЫХ посторонних
// игроков, а не именно того, с кем договорились по коду.
// Фикс: let вместо const, реальное вычисление — внутри setupNetworking(),
// которая вызывается из init() (13-bootstrap.js) уже ПОСЛЕ того как
// MultiplayerMode.mode/roomId окончательно решены экраном выбора. Имена
// переменных не менял — вне этого файла на них никто не ссылается.
let roomRef, myPlayerRef;
const netStatusEl = document.getElementById("netStatus");

function setupNetworking() {
  roomRef = db.ref(`generals_rooms/${roomId}`);
  myPlayerRef = roomRef.child(`players/${localPlayerId}`);

  db.ref(".info/connected").on("value", (snap) => {
    if (snap.val() === true) {
      netStatusEl.textContent = "СЕТЬ: подключено";
      netStatusEl.className = "connected";
      myPlayerRef.onDisconnect().remove();
    } else {
      netStatusEl.textContent = "СЕТЬ: offline";
      netStatusEl.className = "offline";
    }
  });

  // Троттлинг отправки состояния — раз в ~250мс, а не каждый кадр
  setInterval(() => {
    const player = State.players[localPlayerId];
    if (!player) return;
    const myUnits = {};
    Object.values(State.units).filter(u => u.ownerId === localPlayerId).forEach(u => {
      myUnits[u.id] = { type: u.type, x: Math.round(u.x), y: Math.round(u.y), hp: Math.round(u.hp) };
    });
    const myBuildings = {};
    Object.values(State.buildings).filter(b => b.ownerId === localPlayerId).forEach(b => {
      myBuildings[b.id] = { type: b.type, x: Math.round(b.x), y: Math.round(b.y), hp: Math.round(b.hp) };
    });
    myPlayerRef.set({
      credits: Math.floor(player.credits),
      units: myUnits,
      buildings: myBuildings,
      lastSeen: Date.now(),
    }).catch(() => { /* офлайн — молча игнорируем, это прототип */ });
  }, 250);

  // Подписка на изменения комнаты — рисуем "теневых" юнитов удалённого игрока.
  // ПРОМПТ для след. ИИ: сейчас удалённые юниты просто накладываются как
  // read-only объекты State.remoteGhosts — нужно полноценно их интегрировать
  // (столкновения, бой между игроками, авторитетную валидацию урона и т.д.)
  State.remoteGhosts = {};
  roomRef.child("players").on("value", (snap) => {
    const data = snap.val() || {};
    Object.entries(data).forEach(([pid, pdata]) => {
      if (pid === localPlayerId) return;
      State.remoteGhosts[pid] = pdata;
    });
  });
}

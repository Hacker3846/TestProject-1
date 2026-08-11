/* ---------------------------- ИИ №30: статистика боя для экрана победы ---------------------------- */
// Собирает лёгкую сводку по ходу партии, которую показывает новый экран
// победы/поражения (см. переписанный 14-game-end.js). Не хранится в
// State (это чисто UI-метрика, не часть авторитетной модели мира — тот
// же принцип, что и FX{deaths,hitSparks} в 08-render.js, которые тоже
// живут вне State) — глобальный объект BattleStats.
//
// Считаем через переопределение killUnit/killBuilding ПОСЛЕ их объявления
// (тот же приём, что везде в проекте, см. комментарий в 14/16/17) —
// оригинальные функции не трогаются, только подписка на факт убийства.
const BattleStats = {
  startedAtMs: (typeof performance !== "undefined" ? performance.now() : Date.now()),
  playerUnitsLost: 0,
  playerBuildingsLost: 0,
  enemyUnitsLost: 0,       // = юниты, убитые игроком
  enemyBuildingsLost: 0,   // = здания, разрушенные игроком
  peakCredits: 0,
};

function battleStatsElapsedMs() {
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  return now - BattleStats.startedAtMs;
}

function formatDurationShort(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

(function patchKillTrackers() {
  if (typeof killUnit === "function") {
    const _killUnit = killUnit;
    killUnit = function (id) {
      const u = State.units[id];
      if (u) {
        if (u.ownerId === localPlayerId) BattleStats.playerUnitsLost++;
        else BattleStats.enemyUnitsLost++;
      }
      return _killUnit(id);
    };
  }
  if (typeof killBuilding === "function") {
    const _killBuilding = killBuilding;
    killBuilding = function (id) {
      const b = State.buildings[id];
      if (b) {
        if (b.ownerId === localPlayerId) BattleStats.playerBuildingsLost++;
        else BattleStats.enemyBuildingsLost++;
      }
      return _killBuilding(id);
    };
  }
  // Пик кредитов игрока за партию — простая метрика "насколько сильно
  // разогналась экономика", не требует отдельного тика: снимается
  // попутно при каждом renderHUD (уже вызывается раз в игровой тик).
  if (typeof renderHUD === "function") {
    const _renderHUD = renderHUD;
    renderHUD = function () {
      _renderHUD();
      const player = State.players[localPlayerId];
      if (player && player.credits > BattleStats.peakCredits) {
        BattleStats.peakCredits = player.credits;
      }
    };
  }
})();

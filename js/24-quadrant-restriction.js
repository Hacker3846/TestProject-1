/* ---------------------------- ИИ №41: карта делится на 4 сектора, строить можно только в своём ---------------------------- */
// Прямой запрос пользователя: "на карте враг или я можем заспавниться в
// одном из 4 углов, но никогда не в одном и том же, сделай так чтобы карта
// так же делилась на 4 части, а строить можно было только в своей части".
//
// Спавн по углам уже существовал (AssignedCorners.local/enemy, CORNER_SIGNS,
// 20-corner-spawn.js) — этот файл НЕ трогает спавн, только добавляет
// геометрическое ограничение застройки поверх него: карта делится на 4
// равных прямоугольных сектора ровно по центру (mapWidthPx()/2, mapHeightPx()/2),
// каждый угол однозначно соответствует одному сектору (тот же CORNER_SIGNS,
// что и у спавна, — так квадранты гарантированно не разъедутся со спавном
// при будущей правке одного из файлов).
//
// Единая точка входа для ЛЮБОЙ постройки в игре — как у игрока, так и у ИИ,
// включая стены — это isBuildPlacementValid (10-hud.js, использует её и
// 18-walls.js: buildSingleWall/wallChainDrag) и isEnemyBuildPlacementValid
// (06-enemy-ai.js, использует её и enemyPlaceBuilding/зональная застройка
// 21-ai-base-strategy.js, и enemyWallStep/18-walls.js). Патчим только эти
// две функции — оборачиваем, не переписываем: вся существующая проверка
// коллизий/тумана/ресурсов (10-hud.js/06-enemy-ai.js) отрабатывает как
// раньше, сектор — это ДОПОЛНИТЕЛЬНОЕ отсекающее условие поверх неё.
//
// Подключать ПОСЛЕДНИМ в index.html (после 23-map-bounds.js) — обе патчимые
// функции и AssignedCorners/CORNER_SIGNS/mapWidthPx/mapHeightPx к этому
// моменту точно объявлены.

/* ---------------------------- Геометрия секторов ---------------------------- */

// Сектор по индексу угла (0..3) — прямоугольник в мировых px. Используем
// ТЕ ЖЕ CORNER_SIGNS, что и спавн (20-corner-spawn.js): signX>0/signY>0 —
// сектор у левого/верхнего края от центра карты, signX<0/signY<0 — у
// правого/нижнего. Благодаря переиспользованию signX/signY (а не
// собственной копии "0=верхний левый, 1=верхний правый...") сектор угла N
// физически гарантированно содержит точку спавна угла N — расхождение
// между "где спавнится" и "где можно строить" исключено структурно, а не
// проверкой при ревью.
function quadrantBoundsForCorner(idx) {
  const signs = CORNER_SIGNS[idx];
  if (!signs) return null;
  const midX = mapWidthPx() / 2;
  const midY = mapHeightPx() / 2;
  return {
    minX: signs.signX > 0 ? 0 : midX,
    maxX: signs.signX > 0 ? midX : mapWidthPx(),
    minY: signs.signY > 0 ? 0 : midY,
    maxY: signs.signY > 0 ? midY : mapHeightPx(),
  };
}

function isPointInQuadrant(wx, wy, cornerIdx) {
  const b = quadrantBoundsForCorner(cornerIdx);
  if (!b) return true; // неизвестный индекс угла — не блокируем (фолбэк, не должен случаться)
  return wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY;
}

/* ---------------------------- Патч: игрок ---------------------------- */

(function patchIsBuildPlacementValidForQuadrant() {
  if (typeof isBuildPlacementValid !== "function") return;
  const _isBuildPlacementValid = isBuildPlacementValid;
  isBuildPlacementValid = function (key, wx, wy) {
    // AssignedCorners.local может быть ещё не выставлен (вызов до начала
    // партии/в обход стандартного flow старта) — в этом случае не блокируем,
    // как и остальные защитные фолбэки в проекте (см. те же формулировки в
    // 20-corner-spawn.js/patchInitEnemyStubForCornerSpawn).
    if (typeof AssignedCorners !== "undefined" && AssignedCorners.local != null) {
      if (!isPointInQuadrant(wx, wy, AssignedCorners.local)) return false;
    }
    return _isBuildPlacementValid(key, wx, wy);
  };
})();

/* ---------------------------- Патч: ИИ-противник ---------------------------- */

(function patchIsEnemyBuildPlacementValidForQuadrant() {
  if (typeof isEnemyBuildPlacementValid !== "function") return;
  const _isEnemyBuildPlacementValid = isEnemyBuildPlacementValid;
  isEnemyBuildPlacementValid = function (key, wx, wy) {
    // В PvP AssignedCorners.enemy никогда не выставляется (враг — не бот,
    // это функция для ИИ-соперника, см. комментарий в 20-corner-spawn.js) —
    // тогда просто не блокируем, эта функция в PvP и не вызывается.
    if (typeof AssignedCorners !== "undefined" && AssignedCorners.enemy != null) {
      if (!isPointInQuadrant(wx, wy, AssignedCorners.enemy)) return false;
    }
    return _isEnemyBuildPlacementValid(key, wx, wy);
  };
})();

// ЗАМЕТКА: зональная застройка ИИ (21-ai-base-strategy.js, findZoneBuildSpot)
// расширяет кольца поиска до max 300px (defense) от штаба и уже клампит
// точку к границе карты (clampToMapBounds) ДО вызова isEnemyBuildPlacementValid
// — при спавне в углу (margin ~12% меньшей стороны карты, cornerMarginPx())
// сектор вокруг штаба обычно заметно шире 300px до границы своего же
// квадранта, поэтому в норме это не должно приводить к массовым отказам.
// Если на будущей карте меньшего размера ИИ начнёт часто "не находить место"
// у границы своего квадранта — findZoneBuildSpot и так уже умеет фолбэчить
// на poиск по всему кругу и просто пропускать тик застройки при полном
// отсутствии места (enemyPlaceBuilding: `if (!spot) return;`), игра не
// ломается, база просто растёт медленнее у самого края.

// НЕ ПРОВЕРЕНО ВЖИВУЮ (нет браузерного окружения в этой сессии): (1) что
// игрок физически не может подтвердить/протянуть стену через границу
// своего квадранта на всех 4 возможных углах спавна; (2) что ИИ во всех 4
// возможных углах продолжает нормально достраивать полную базу (economy/
// production/defense зоны + стены) в границах одного квадранта, не залипая
// на пустых decision-тиках из-за нехватки места ближе к центру карты.

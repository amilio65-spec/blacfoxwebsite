// Animated dot-grid background for <canvas class="hero-bg-grid">. Shared by every
// page (identical on all 9) -- edit here once rather than per page.
(function () {
  var canvases = document.querySelectorAll('canvas.hero-bg-grid');
  canvases.forEach(function (canvas) {
    var ctx = canvas.getContext('2d');
    var squareSize = 64;
    var mouse = { x: -9999, y: -9999 };
    var grid = [];
    var width = 0, height = 0;

    function initGrid() {
      grid.length = 0;
      for (var x = 0; x < width; x += squareSize) {
        for (var y = 0; y < height; y += squareSize) {
          grid.push({ x: x, y: y, alpha: 0, fading: false, lastTouched: 0 });
        }
      }
    }

    function resize() {
      var rect = canvas.parentElement.getBoundingClientRect();
      width = canvas.width = rect.width;
      height = canvas.height = rect.height;
      initGrid();
    }

    function getCellAt(x, y) {
      return grid.find(function (cell) {
        return x >= cell.x && x < cell.x + squareSize && y >= cell.y && y < cell.y + squareSize;
      });
    }

    function onMouseMove(e) {
      var rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      if (mouse.x < 0 || mouse.y < 0 || mouse.x > width || mouse.y > height) return;
      var cell = getCellAt(mouse.x, mouse.y);
      if (cell && cell.alpha === 0) {
        cell.alpha = 1;
        cell.lastTouched = Date.now();
        cell.fading = false;
      }
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      var now = Date.now();
      for (var i = 0; i < grid.length; i++) {
        var cell = grid[i];
        if (cell.alpha > 0 && !cell.fading && now - cell.lastTouched > 500) cell.fading = true;
        if (cell.fading) {
          cell.alpha -= 0.02;
          if (cell.alpha <= 0) { cell.alpha = 0; cell.fading = false; }
        }
        if (cell.alpha > 0) {
          var cx = cell.x + squareSize / 2;
          var cy = cell.y + squareSize / 2;
          var gradient = ctx.createRadialGradient(cx, cy, 5, cx, cy, squareSize);
          gradient.addColorStop(0, 'rgba(233, 92, 37, ' + cell.alpha + ')');
          gradient.addColorStop(1, 'rgba(233, 92, 37, 0)');
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1.3;
          ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, squareSize - 1, squareSize - 1);
        }
      }
      requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas.parentElement);
    window.addEventListener('mousemove', onMouseMove);
    draw();
  });
})();

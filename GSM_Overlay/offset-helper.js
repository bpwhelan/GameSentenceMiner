const { ipcRenderer } = require('electron');

const offsetDisplay = document.getElementById('offset-display');
// Internal state is in percentage for consistency with index.html
let offsetX = 0;
let offsetY = 0;
let textBoxes = []; // To hold all the created text box elements
let windowWidth = window.innerWidth;
let windowHeight = window.innerHeight;

// --- Movement & Acceleration ---
let keysDown = {};
let speedX = 0;
let speedY = 0;
const maxSpeed = 5;
const acceleration = 0.5;
let movementInterval = null;

const startMovement = () => {
  if (!movementInterval) {
    movementInterval = setInterval(updateMovement, 16); // ~60fps
  }
};

const stopMovement = () => {
  if (movementInterval && Object.keys(keysDown).length === 0) {
    clearInterval(movementInterval);
    movementInterval = null;
  }
};

function updateMovement() {
  let moved = false;

  // Y-axis movement (in percentage units, mapped from pixel speed)
  if (keysDown['ArrowUp']) {
    speedY = Math.max(-maxSpeed, speedY - acceleration);
    // Convert pixel speed to percentage movement
    offsetY += (speedY / windowHeight) * 100;
    moved = true;
  } else if (keysDown['ArrowDown']) {
    speedY = Math.min(maxSpeed, speedY + acceleration);
    offsetY += (speedY / windowHeight) * 100;
    moved = true;
  }

  // X-axis movement (in percentage units, mapped from pixel speed)
  if (keysDown['ArrowLeft']) {
    speedX = Math.max(-maxSpeed, speedX - acceleration);
    offsetX += (speedX / windowWidth) * 100;
    moved = true;
  } else if (keysDown['ArrowRight']) {
    speedX = Math.min(maxSpeed, speedX + acceleration);
    offsetX += (speedX / windowWidth) * 100;
    moved = true;
  }

  if (moved) {
    updateTextPosition();
    updateOffsetDisplay();
  }
}


ipcRenderer.on('text-data', (event, data) => {
  console.log('Received text data for helper:', data);
  const { textData, settings, windowBounds } = data;

  // Use window bounds from main process for accurate calculations
  if (windowBounds) {
    windowWidth = windowBounds.width;
    windowHeight = windowBounds.height;
    console.log('Using window bounds:', windowWidth, 'x', windowHeight);
  }

  // Use incoming percentage offset directly
  offsetX = settings.offsetX || 0;
  offsetY = settings.offsetY || 0;

  // Clear any existing text boxes
  textBoxes.forEach(box => box.remove());
  textBoxes = [];

  const fragment = document.createDocumentFragment();

  if (Array.isArray(textData) && textData.length > 0) {
    for (const line of textData) {
      if (!line.words) continue;
      for (const word of line.words) {
        const rect = word.bounding_rect;
        let x1 = rect.x1 * 100;
        let y1 = rect.y1 * 100;
        let x3 = rect.x3 * 100;
        let y3 = rect.y3 * 100;

        const box = document.createElement('span');
        box.className = 'text-box';
        box.textContent = word.text;

        const boxHeight = (y3 - y1) / 100 * windowHeight;
        box.style.fontSize = `${Math.max(8, Math.min(100, Math.round(boxHeight)))}px`;
        
        // Store base position and apply offset the same way as index.html
        box.dataset.baseLeft = x1;
        box.dataset.baseTop = y1;
        box.style.left = `${x1 + offsetX}%`;
        box.style.top = `${y1 + offsetY}%`;
        box.style.width = `${x3 - x1}%`;
        box.style.height = `${y3 - y1}%`;

        textBoxes.push(box);
        fragment.appendChild(box);
      }
    }
  } else if (textData.sentence) {
    const box = document.createElement('div');
    box.className = 'text-box';
    box.innerText = textData.sentence;
    box.style.fontSize = `${settings.fontSize || 42}px`;
    box.dataset.baseLeft = 50;
    box.dataset.baseTop = 50;
    box.style.left = `${50 + offsetX}%`;
    box.style.top = `${50 + offsetY}%`;
    box.style.transform = 'translate(-50%, -50%)';
    textBoxes.push(box);
    fragment.appendChild(box);
  }
  
  document.body.appendChild(fragment);

  updateOffsetDisplay();
});

function updateTextPosition() {
  textBoxes.forEach(box => {
    const baseLeft = parseFloat(box.dataset.baseLeft);
    const baseTop = parseFloat(box.dataset.baseTop);
    
    box.style.left = `${baseLeft + offsetX}%`;
    box.style.top = `${baseTop + offsetY}%`;
  });
}

function updateOffsetDisplay() {
  // Convert to pixels for display
  const pixelX = Math.round((offsetX / 100) * windowWidth);
  const pixelY = Math.round((offsetY / 100) * windowHeight);
  offsetDisplay.innerText = `X: ${pixelX}px (${offsetX.toFixed(2)}%), Y: ${pixelY}px (${offsetY.toFixed(2)}%)`;
}

document.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      keysDown[event.key] = true;
      startMovement();
      break;
    case 'Enter':
    case 's':
      if (event.ctrlKey || event.key === 'Enter') {
        saveOffset();
      }
      break;
    case 'Escape':
      window.close();
      break;
  }
});

document.addEventListener('keyup', (event) => {
    delete keysDown[event.key];
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        speedY = 0;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        speedX = 0;
    }
    stopMovement();
});

function saveOffset() {
  // offsetX and offsetY are already in percentage
  ipcRenderer.send('save-offset', { offsetX: offsetX, offsetY: offsetY });
  window.close();
}

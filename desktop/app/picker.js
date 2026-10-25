'use strict';
document.getElementById('cancel').addEventListener('click', () => window.lumenPicker.cancel());
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.lumenPicker.cancel(); });
window.lumenPicker.sources().then(({ sources, audio }) => {
  document.getElementById('audio-option').hidden = !audio;
  for (const source of sources) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'source';
    const preview = document.createElement('img'); preview.src = source.thumbnail; preview.alt = '';
    const label = document.createElement('span'); label.textContent = source.name;
    button.append(preview, label);
    button.addEventListener('click', () => window.lumenPicker.choose(source.id, document.getElementById('audio').checked));
    document.getElementById('sources').append(button);
  }
  document.querySelector('.source')?.focus();
}).catch(() => window.lumenPicker.cancel());

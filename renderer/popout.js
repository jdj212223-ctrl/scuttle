// The desktop pet: a transparent, click-through window over the whole screen.
// Clicks only get caught while the mouse is over the pet itself.
let pet = null;
const S = window.scuttle;
S.pet.onEvent((ev) => {
  if (ev.type === 'show') {
    if (!pet) {
      pet = new ScuttlePets.Pet(document.body, ev.opts);
      pet.on('hover', (inside) => S.pet.mouse(inside));
      pet.on('menu', () => { S.pet.mouse(false); S.pet.goHome(); }); // right-click: go back into the editor
    } else pet.applyOpts(ev.opts);
    pet.show();
    pet.say(`I'm free! (right-click me to go home)`, 4000);
  } else if (ev.type === 'opts' && pet) pet.applyOpts(ev.opts);
  else if (ev.type === 'react' && pet) pet.react(ev.kind);
  else if (ev.type === 'activity' && pet) pet.activity(); // you typed in the editor
});

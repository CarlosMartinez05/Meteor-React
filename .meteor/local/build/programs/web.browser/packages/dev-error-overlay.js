//////////////////////////////////////////////////////////////////////////
//                                                                      //
// This is a generated file. You can view the original                  //
// source in your browser if your browser supports source maps.         //
// Source maps are supported by all recent versions of Chrome, Safari,  //
// and Firefox, and by Internet Explorer 11.                            //
//                                                                      //
//////////////////////////////////////////////////////////////////////////


(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var meteorInstall = Package.modules.meteorInstall;

/* Package-scope variables */
var DevErrorOverlay;

var require = meteorInstall({"node_modules":{"meteor":{"dev-error-overlay":{"client.js":function module(){

////////////////////////////////////////////////////////////////////////////
//                                                                        //
// packages/dev-error-overlay/client.js                                   //
//                                                                        //
////////////////////////////////////////////////////////////////////////////
                                                                          //
const styles = `
  .container {
    all: initial;
    background: #FEFEFE;
    padding: 50px;
    min-height: 30vh;
    max-height: 100%;
    width: 100%;
    position: fixed;
    left: 0;
    top: 0;
    font-family: sans-serif;
    box-shadow: inset 0 0 100px #e411111f, 0 0 20px #00000085;
    box-sizing: border-box;
    overflow-y: auto;
    z-index: 1000000;
  }

  .section {
    margin-bottom: 50px;
  }

  pre {
    overflow-x: auto;
  }
`;

function createSection (title, content) {
  var sectionContainer = document.createElement('div');
  sectionContainer.classList.add('section');

  var header = document.createElement('h3');
  header.textContent = title;
  sectionContainer.appendChild(header);

  var message = document.createElement('pre');
  message.innerHTML = content;
  sectionContainer.appendChild(message);

  return sectionContainer;
}

let container = null;
let contentEl = null;

function init () {
  if (container) {
    return;
  }

  container = document.createElement('div');
  document.body.append(container);

  contentEl = document.createElement('div');
  contentEl.classList.add('container');

  let shadow = container.attachShadow({ mode: 'open' });
  shadow.appendChild(contentEl);

  let style = document.createElement('style');
  style.textContent = styles;
  shadow.appendChild(style);

  let button = document.createElement('button');
  button.textContent = 'Close';
  button.addEventListener('click', close);
  contentEl.appendChild(button);
}

function close() {
  document.body.removeChild(container);
  container = null;
  contentEl = null;
}

DevErrorOverlay = {
  showMessage(title, message) {
    init();

    let sectionEl = createSection(title, message);
    contentEl.prepend(sectionEl);

    return () => {
      if (container && contentEl && sectionEl.parentNode === contentEl) {
        contentEl.removeChild(sectionEl);

        if (contentEl.childNodes.length === 1) {
          close();
        }
      }
    };
  }
}

////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

require("/node_modules/meteor/dev-error-overlay/client.js");

/* Exports */
Package._define("dev-error-overlay", {
  DevErrorOverlay: DevErrorOverlay
});

})();

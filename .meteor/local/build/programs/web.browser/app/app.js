var require = meteorInstall({"imports":{"api":{"Collections":{"PatientCollection.js":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/api/Collections/PatientCollection.js                                                     //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  module1.export({
    PatientCollection: () => PatientCollection
  });
  let Mongo;
  module1.link("meteor/mongo", {
    Mongo(v) {
      Mongo = v;
    }

  }, 0);

  ___INIT_METEOR_FAST_REFRESH(module);

  const PatientCollection = new Mongo.Collection('Patients2');
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

}}},"ui":{"components":{"Footer.jsx":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/ui/components/Footer.jsx                                                                 //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  let React;
  module1.link("react", {
    default(v) {
      React = v;
    }

  }, 0);

  ___INIT_METEOR_FAST_REFRESH(module);

  const Footer = () => {
    return /*#__PURE__*/React.createElement("div", {
      className: "Footer"
    }, /*#__PURE__*/React.createElement("h1", null, "Esto es Footer"));
  };

  _c = Footer;
  module1.exportDefault(Footer);

  var _c;

  $RefreshReg$(_c, "Footer");
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

},"NavBar.jsx":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/ui/components/NavBar.jsx                                                                 //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  let React;
  module1.link("react", {
    default(v) {
      React = v;
    }

  }, 0);

  ___INIT_METEOR_FAST_REFRESH(module);

  const NavBar = () => {
    return /*#__PURE__*/React.createElement("div", {
      className: "NavBar"
    }, /*#__PURE__*/React.createElement("h1", null, "Esto es El NavBar"));
  };

  _c = NavBar;
  module1.exportDefault(NavBar);

  var _c;

  $RefreshReg$(_c, "NavBar");
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

},"Patient.jsx":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/ui/components/Patient.jsx                                                                //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  let React;
  module1.link("react", {
    default(v) {
      React = v;
    }

  }, 0);
  let patient;
  module1.link("../../api/Collections/PatientCollection", {
    default(v) {
      patient = v;
    }

  }, 1);

  ___INIT_METEOR_FAST_REFRESH(module);

  const Patient = _ref => {
    let {
      patient,
      onDeleteClick
    } = _ref;
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Nombre y Apellido"), /*#__PURE__*/React.createElement("th", null, "Rut"), /*#__PURE__*/React.createElement("th", null, "zipCode"), /*#__PURE__*/React.createElement("th", null, "County"), /*#__PURE__*/React.createElement("th", null, "state")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", null, patient.name, "-", patient.FirstLastName, "-", patient.SecondLastName), /*#__PURE__*/React.createElement("td", null, patient.Rut), /*#__PURE__*/React.createElement("td", null, patient.zipCode), /*#__PURE__*/React.createElement("td", null, patient.state), /*#__PURE__*/React.createElement("td", null, patient.county), /*#__PURE__*/React.createElement("button", {
      onClick: () => onDeleteClick(patient),
      value: "eliminar"
    }, "ELIMINAR")));
  };

  _c = Patient;
  module1.exportDefault(Patient);

  var _c;

  $RefreshReg$(_c, "Patient");
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

},"PatientForm.jsx":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/ui/components/PatientForm.jsx                                                            //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  let _extends;

  module1.link("@babel/runtime/helpers/extends", {
    default(v) {
      _extends = v;
    }

  }, 0);
  let React, useState;
  module1.link("react", {
    default(v) {
      React = v;
    },

    useState(v) {
      useState = v;
    }

  }, 0);
  let PatientCollection;
  module1.link("../../api/Collections/PatientCollection", {
    PatientCollection(v) {
      PatientCollection = v;
    }

  }, 1);
  let useForm;
  module1.link("react-hook-form", {
    useForm(v) {
      useForm = v;
    }

  }, 2);
  let validateRut, formatRut;
  module1.link("rutlib", {
    validateRut(v) {
      validateRut = v;
    },

    formatRut(v) {
      formatRut = v;
    }

  }, 3);

  ___INIT_METEOR_FAST_REFRESH(module);

  var _s = $RefreshSig$();

  const PatientForm = () => {
    _s(); //SetState and Const for parameters


    const {
      register,
      handleSubmit,
      formState: {
        errors
      }
    } = useForm();

    const submit = data => {
      console.log(data);
      PatientCollection.insert(data);
    };

    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("form", {
      onSubmit: handleSubmit(submit)
    }, /*#__PURE__*/React.createElement("label", {
      htmlFor: "name"
    }, "First name "), /*#__PURE__*/React.createElement("input", _extends({
      autoComplete: "name",
      type: "text",
      placeholder: "Nombre"
    }, register('name', {
      required: true
    }))), errors.name && /*#__PURE__*/React.createElement("p", null, "Se necesita Un Nombre"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "FirstLastName"
    }, "Apellido Materno "), /*#__PURE__*/React.createElement("input", _extends({
      type: "text",
      placeholder: "Apellido Paterno"
    }, register('FirstLastName', {
      required: true
    }))), errors.FirstLastName && /*#__PURE__*/React.createElement("p", null, "Necesitas Un Apellido Paterno"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "SecondLastName"
    }, "Apellido Materno "), /*#__PURE__*/React.createElement("input", {
      type: "text",
      placeholder: "Apellido Materno"
    }), /*#__PURE__*/React.createElement("label", {
      htmlFor: "Rut"
    }, "Rut "), /*#__PURE__*/React.createElement("input", _extends({
      type: "text",
      placeholder: "Rut"
    }, register('Rut', {
      required: true,
      validate: validateRut
    }))), errors.Rut && /*#__PURE__*/React.createElement("p", null, "Se Necesita Un Rut"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "zipCode"
    }, "Codigo Postal "), /*#__PURE__*/React.createElement("input", _extends({
      type: "text",
      placeholder: "Codigo Postal"
    }, register('zipCode', {
      required: true
    }))), errors.zipCode && /*#__PURE__*/React.createElement("p", null, "Se Necesita Un Codigo Postal"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "state"
    }, "Region "), /*#__PURE__*/React.createElement("input", _extends({
      type: "text",
      placeholder: "Region"
    }, register('state', {
      required: true
    }))), errors.state && /*#__PURE__*/React.createElement("p", null, "Se Necesita Una Region"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "county"
    }, "Comuna"), /*#__PURE__*/React.createElement("input", _extends({
      type: "text",
      placerholder: "Comuna"
    }, register('county', {
      required: true
    }))), errors.county && /*#__PURE__*/React.createElement("p", null, "Se Necesita Una Comuna"), /*#__PURE__*/React.createElement("button", {
      type: "submit"
    }, "enviar")));
  };

  _s(PatientForm, "HLC1IFclXfL/K+q6lxeDS/Po7Wk=", false, function () {
    return [useForm];
  });

  _c = PatientForm;
  module1.exportDefault(PatientForm);

  var _c;

  $RefreshReg$(_c, "PatientForm");
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

}},"App.jsx":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/ui/App.jsx                                                                               //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  let React;
  module1.link("react", {
    default(v) {
      React = v;
    }

  }, 0);
  let PatientCollection;
  module1.link("../api/Collections/PatientCollection", {
    PatientCollection(v) {
      PatientCollection = v;
    }

  }, 1);
  let Patient;
  module1.link("../ui/components/Patient", {
    default(v) {
      Patient = v;
    }

  }, 2);
  let PatientForm;
  module1.link("./components/PatientForm", {
    default(v) {
      PatientForm = v;
    }

  }, 3);
  let useTracker;
  module1.link("meteor/react-meteor-data", {
    useTracker(v) {
      useTracker = v;
    }

  }, 4);
  let NavBar;
  module1.link("./components/NavBar", {
    default(v) {
      NavBar = v;
    }

  }, 5);
  let Footer;
  module1.link("./components/Footer", {
    default(v) {
      Footer = v;
    }

  }, 6);

  ___INIT_METEOR_FAST_REFRESH(module);

  var _s = $RefreshSig$();

  const deletePatient = _ref => {
    let {
      _id
    } = _ref;
    return PatientCollection.remove(_id);
  };

  const App = () => {
    _s();

    const patients = useTracker(() => PatientCollection.find({}, {
      sort: {
        createdAt: -1
      }
    }).fetch());
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(NavBar, null), /*#__PURE__*/React.createElement("h1", {
      className: "text-3xl font-bold underline"
    }, "prueba registro Pacientes"), /*#__PURE__*/React.createElement(PatientForm, null), patients.map(patient => /*#__PURE__*/React.createElement(Patient, {
      key: patient._id,
      patient: patient,
      onDeleteClick: deletePatient
    })), /*#__PURE__*/React.createElement(Footer, null));
  };

  _s(App, "tQirp9HU8dzIOPBFuhisnzHbbnM=", false, function () {
    return [useTracker];
  });

  _c = App;
  module1.exportDefault(App);

  var _c;

  $RefreshReg$(_c, "App");
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

}}},"client":{"main.jsx":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// client/main.jsx                                                                                  //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  let React;
  module1.link("react", {
    default(v) {
      React = v;
    }

  }, 0);
  let Meteor;
  module1.link("meteor/meteor", {
    Meteor(v) {
      Meteor = v;
    }

  }, 1);
  let render;
  module1.link("react-dom", {
    render(v) {
      render = v;
    }

  }, 2);
  let App;
  module1.link("/imports/ui/App", {
    default(v) {
      App = v;
    }

  }, 3);

  ___INIT_METEOR_FAST_REFRESH(module);

  Meteor.startup(() => {
    render( /*#__PURE__*/React.createElement(App, null), document.getElementById('react-target'));
  });
}.call(this, module);
//////////////////////////////////////////////////////////////////////////////////////////////////////

}}},{
  "extensions": [
    ".js",
    ".json",
    ".html",
    ".ts",
    ".css",
    ".mjs",
    ".jsx"
  ]
});

var exports = require("/client/main.jsx");
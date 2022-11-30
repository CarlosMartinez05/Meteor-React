var require = meteorInstall({"imports":{"api":{"Collections":{"PatientCollection.js":function module(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                  //
// imports/api/Collections/PatientCollection.js                                                     //
//                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                    //
!function (module1) {
  module1.export({
    PatientCollection: function () {
      return PatientCollection;
    }
  });
  var Mongo;
  module1.link("meteor/mongo", {
    Mongo: function (v) {
      Mongo = v;
    }
  }, 0);

  ___INIT_METEOR_FAST_REFRESH(module);

  var PatientCollection = new Mongo.Collection('Patients2');
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
  var React;
  module1.link("react", {
    "default": function (v) {
      React = v;
    }
  }, 0);

  ___INIT_METEOR_FAST_REFRESH(module);

  var Footer = function () {
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
  var React;
  module1.link("react", {
    "default": function (v) {
      React = v;
    }
  }, 0);

  ___INIT_METEOR_FAST_REFRESH(module);

  var NavBar = function () {
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
  var React;
  module1.link("react", {
    "default": function (v) {
      React = v;
    }
  }, 0);
  var patient;
  module1.link("../../api/Collections/PatientCollection", {
    "default": function (v) {
      patient = v;
    }
  }, 1);

  ___INIT_METEOR_FAST_REFRESH(module);

  var Patient = function (_ref) {
    var patient = _ref.patient,
        onDeleteClick = _ref.onDeleteClick;
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Nombre y Apellido"), /*#__PURE__*/React.createElement("th", null, "Rut"), /*#__PURE__*/React.createElement("th", null, "zipCode"), /*#__PURE__*/React.createElement("th", null, "County"), /*#__PURE__*/React.createElement("th", null, "state")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", null, patient.name, "-", patient.FirstLastName, "-", patient.SecondLastName), /*#__PURE__*/React.createElement("td", null, patient.Rut), /*#__PURE__*/React.createElement("td", null, patient.zipCode), /*#__PURE__*/React.createElement("td", null, patient.state), /*#__PURE__*/React.createElement("td", null, patient.county), /*#__PURE__*/React.createElement("button", {
      onClick: function () {
        return onDeleteClick(patient);
      },
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
  var _extends;

  module1.link("@babel/runtime/helpers/extends", {
    default: function (v) {
      _extends = v;
    }
  }, 0);
  var React, useState;
  module1.link("react", {
    "default": function (v) {
      React = v;
    },
    useState: function (v) {
      useState = v;
    }
  }, 0);
  var PatientCollection;
  module1.link("../../api/Collections/PatientCollection", {
    PatientCollection: function (v) {
      PatientCollection = v;
    }
  }, 1);
  var useForm;
  module1.link("react-hook-form", {
    useForm: function (v) {
      useForm = v;
    }
  }, 2);
  var validateRut, formatRut;
  module1.link("rutlib", {
    validateRut: function (v) {
      validateRut = v;
    },
    formatRut: function (v) {
      formatRut = v;
    }
  }, 3);

  ___INIT_METEOR_FAST_REFRESH(module);

  var _s = $RefreshSig$();

  var PatientForm = function () {
    _s(); //SetState and Const for parameters


    var _useForm = useForm(),
        register = _useForm.register,
        handleSubmit = _useForm.handleSubmit,
        errors = _useForm.formState.errors;

    var submit = function (data) {
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
  var React;
  module1.link("react", {
    "default": function (v) {
      React = v;
    }
  }, 0);
  var PatientCollection;
  module1.link("../api/Collections/PatientCollection", {
    PatientCollection: function (v) {
      PatientCollection = v;
    }
  }, 1);
  var Patient;
  module1.link("../ui/components/Patient", {
    "default": function (v) {
      Patient = v;
    }
  }, 2);
  var PatientForm;
  module1.link("./components/PatientForm", {
    "default": function (v) {
      PatientForm = v;
    }
  }, 3);
  var useTracker;
  module1.link("meteor/react-meteor-data", {
    useTracker: function (v) {
      useTracker = v;
    }
  }, 4);
  var NavBar;
  module1.link("./components/NavBar", {
    "default": function (v) {
      NavBar = v;
    }
  }, 5);
  var Footer;
  module1.link("./components/Footer", {
    "default": function (v) {
      Footer = v;
    }
  }, 6);

  ___INIT_METEOR_FAST_REFRESH(module);

  var _s = $RefreshSig$();

  var deletePatient = function (_ref) {
    var _id = _ref._id;
    return PatientCollection.remove(_id);
  };

  var App = function () {
    _s();

    var patients = useTracker(function () {
      return PatientCollection.find({}, {
        sort: {
          createdAt: -1
        }
      }).fetch();
    });
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(NavBar, null), /*#__PURE__*/React.createElement("h1", {
      className: "text-3xl font-bold underline"
    }, "prueba registro Pacientes"), /*#__PURE__*/React.createElement(PatientForm, null), patients.map(function (patient) {
      return /*#__PURE__*/React.createElement(Patient, {
        key: patient._id,
        patient: patient,
        onDeleteClick: deletePatient
      });
    }), /*#__PURE__*/React.createElement(Footer, null));
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
  var React;
  module1.link("react", {
    "default": function (v) {
      React = v;
    }
  }, 0);
  var Meteor;
  module1.link("meteor/meteor", {
    Meteor: function (v) {
      Meteor = v;
    }
  }, 1);
  var render;
  module1.link("react-dom", {
    render: function (v) {
      render = v;
    }
  }, 2);
  var App;
  module1.link("/imports/ui/App", {
    "default": function (v) {
      App = v;
    }
  }, 3);

  ___INIT_METEOR_FAST_REFRESH(module);

  Meteor.startup(function () {
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
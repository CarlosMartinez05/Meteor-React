var require = meteorInstall({"imports":{"api":{"Collections":{"PatientCollection.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// imports/api/Collections/PatientCollection.js                                                    //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////

}}},"ui":{"components":{"Footer.jsx":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// imports/ui/components/Footer.jsx                                                                //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////

},"NavBar.jsx":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// imports/ui/components/NavBar.jsx                                                                //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////

},"Patient.jsx":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// imports/ui/components/Patient.jsx                                                               //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////

},"PatientForm.jsx":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// imports/ui/components/PatientForm.jsx                                                           //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                   //
!function (module1) {
  var _regeneratorRuntime;

  module1.link("@babel/runtime/regenerator", {
    default: function (v) {
      _regeneratorRuntime = v;
    }
  }, 0);

  var _extends;

  module1.link("@babel/runtime/helpers/extends", {
    default: function (v) {
      _extends = v;
    }
  }, 1);

  var _slicedToArray;

  module1.link("@babel/runtime/helpers/slicedToArray", {
    default: function (v) {
      _slicedToArray = v;
    }
  }, 2);
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

  ___INIT_METEOR_FAST_REFRESH(module);

  var _s = $RefreshSig$();

  var PatientForm = function () {
    _s(); //SetState and Const for parameters


    var _useState = useState(""),
        _useState2 = _slicedToArray(_useState, 2),
        name = _useState2[0],
        setName = _useState2[1];

    var _useState3 = useState(""),
        _useState4 = _slicedToArray(_useState3, 2),
        FirstLastName = _useState4[0],
        setFirstLastName = _useState4[1];

    var _useState5 = useState(""),
        _useState6 = _slicedToArray(_useState5, 2),
        SecondLastName = _useState6[0],
        setSecondLastName = _useState6[1];

    var _useState7 = useState(""),
        _useState8 = _slicedToArray(_useState7, 2),
        Rut = _useState8[0],
        setRut = _useState8[1];

    var _useState9 = useState(""),
        _useState10 = _slicedToArray(_useState9, 2),
        zipCode = _useState10[0],
        setZipCode = _useState10[1];

    var _useState11 = useState(""),
        _useState12 = _slicedToArray(_useState11, 2),
        state = _useState12[0],
        setState = _useState12[1];

    var _useState13 = useState(""),
        _useState14 = _slicedToArray(_useState13, 2),
        county = _useState14[0],
        setCounty = _useState14[1];

    var _useForm = useForm(),
        register = _useForm.register,
        handleSubmit = _useForm.handleSubmit,
        errors = _useForm.formState.errors;

    var submit = function () {
      function _callee(data) {
        return _regeneratorRuntime.async(function () {
          function _callee$(_context) {
            while (1) {
              switch (_context.prev = _context.next) {
                case 0:
                  _context.next = 2;
                  return _regeneratorRuntime.awrap(data.preventDefault);

                case 2:
                  if (Rut) {
                    _context.next = 4;
                    break;
                  }

                  return _context.abrupt("return");

                case 4:
                  PatientCollection.insert({
                    name: name,
                    FirstLastName: FirstLastName,
                    SecondLastName: SecondLastName,
                    Rut: Rut,
                    zipCode: zipCode,
                    state: state,
                    county: county
                  });
                  setName("");
                  setFirstLastName("");
                  setSecondLastName("");
                  setRut("");
                  setZipCode("");
                  setState("");
                  setCounty("");

                case 12:
                case "end":
                  return _context.stop();
              }
            }
          }

          return _callee$;
        }(), null, null, null, Promise);
      }

      return _callee;
    }();

    return /*#__PURE__*/React.createElement("div", {
      className: "md:container px-10 py-4 bg-slate-300"
    }, /*#__PURE__*/React.createElement("form", {
      onSubmit: handleSubmit(submit)
    }, /*#__PURE__*/React.createElement("label", {
      htmlFor: "name",
      className: "block text-sm font-medium text-gray-700"
    }, "First name "), /*#__PURE__*/React.createElement("input", _extends({
      className: "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      autoComplete: "name",
      type: "text",
      placeholder: "Type to Name",
      value: name
    }, register('name', {
      required: true
    }), {
      onChange: function (e) {
        return setName(e.target.value);
      }
    })), errors.name && /*#__PURE__*/React.createElement("p", null, "Se necesita Un Nombre"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "FirstLastName",
      className: "block text-sm font-medium text-gray-700"
    }, "Apellido Materno "), /*#__PURE__*/React.createElement("input", _extends({
      className: "mt-1 block w-full rounded-md border-blue-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      type: "text",
      placeholder: "Type firstLastName",
      value: FirstLastName
    }, register('FirstLastName', {
      required: true
    }), {
      onChange: function (e) {
        return setFirstLastName(e.target.value);
      }
    })), errors.FirstLastName && /*#__PURE__*/React.createElement("p", null, "Necesitas Un Apellido Paterno"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "SecondLastName",
      className: "block text-sm font-medium text-gray-700"
    }, "Apellido Materno "), /*#__PURE__*/React.createElement("input", {
      className: "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      type: "text",
      placeholder: "Type Second Last Name",
      value: SecondLastName,
      onChange: function (e) {
        return setSecondLastName(e.target.value);
      }
    }), /*#__PURE__*/React.createElement("label", {
      htmlFor: "Rut",
      className: "block text-sm font-medium text-gray-700"
    }, "Rut "), /*#__PURE__*/React.createElement("input", _extends({
      className: "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      type: "text",
      placeholder: "Type to rut",
      value: Rut
    }, register('Rut', {
      required: true
    }), {
      onChange: function (e) {
        return setRut(e.target.value);
      }
    })), errors.Rut && /*#__PURE__*/React.createElement("p", null, "Se Necesita Un Rut"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "zipCode",
      className: "block text-sm font-medium text-gray-700"
    }, "Codigo Postal "), /*#__PURE__*/React.createElement("input", _extends({
      className: "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      type: "text",
      placeholder: "Type to zip code",
      value: zipCode
    }, register('zipCode', {
      required: true
    }), {
      onChange: function (e) {
        return setZipCode(e.target.value);
      }
    })), errors.zipCode && /*#__PURE__*/React.createElement("p", null, "Se Necesita Un Codigo Postal"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "state",
      className: "block text-sm font-medium text-gray-700"
    }, "Region "), /*#__PURE__*/React.createElement("input", _extends({
      className: "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      type: "text",
      placeholder: "Select Your State",
      value: state
    }, register('state', {
      required: true
    }), {
      onChange: function (e) {
        return setState(e.target.value);
      }
    })), errors.state && /*#__PURE__*/React.createElement("p", null, "Se Necesita Una Region"), /*#__PURE__*/React.createElement("label", {
      htmlFor: "county",
      className: "block text-sm font-medium text-gray-700"
    }, "Comuna "), /*#__PURE__*/React.createElement("input", _extends({
      className: "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm",
      type: "text",
      placerholder: "Select Your County",
      value: county
    }, register('county', {
      required: true
    }), {
      onChange: function (e) {
        return setCounty(e.target.value);
      }
    })), errors.county && /*#__PURE__*/React.createElement("p", null, "Se Necesita Una Comuna"), /*#__PURE__*/React.createElement("button", {
      type: "submit",
      className: "bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
    }, "enviar")));
  };

  _s(PatientForm, "YESj40tedrML8FoRZK2Nr5RbkwE=", false, function () {
    return [useForm];
  });

  _c = PatientForm;
  module1.exportDefault(PatientForm);

  var _c;

  $RefreshReg$(_c, "PatientForm");
}.call(this, module);
/////////////////////////////////////////////////////////////////////////////////////////////////////

}},"App.jsx":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// imports/ui/App.jsx                                                                              //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////

}}},"client":{"main.jsx":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                 //
// client/main.jsx                                                                                 //
//                                                                                                 //
/////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////

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
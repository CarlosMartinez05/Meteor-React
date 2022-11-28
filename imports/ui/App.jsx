import React from "react";
import { PatientCollection } from "../api/Collections/PatientCollection";
import Patient from '../ui/components/Patient';
import PatientForm from './components/PatientForm';
import {useTracker} from 'meteor/react-meteor-data';
import NavBar from './components/NavBar';
import Footer from './components/Footer';

const deletePatient = ({_id}) => PatientCollection.remove(_id);

const App = () => {

  const patients = useTracker(() => PatientCollection.find({}, { sort: { createdAt: -1 } }).fetch());



return (
<div>
  <NavBar/>
    <h1 className="text-3xl font-bold underline">prueba registro Pacientes</h1>
    <PatientForm/>
        {patients.map(patient => <Patient key={ patient._id }patient={patient}onDeleteClick={deletePatient}/>)}
  <Footer/>
  </div>
  )
};


export default App;






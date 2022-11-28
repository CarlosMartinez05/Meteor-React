import React from 'react'
import patient from '../../api/Collections/PatientCollection'


const Patient = ({patient, onDeleteClick}) => {
  return (
    <div>
      <tr>
        <th>Nombre y Apellido</th>
        <th>Rut</th>
        <th>zipCode</th>
        <th>County</th>
        <th>state</th>
        </tr>
        <tr>
        <td>{patient.name}-{patient.FirstLastName}-{patient.SecondLastName}</td>
        <td>{patient.Rut}</td>
        <td>{patient.zipCode}</td>
        <td>{patient.state}</td>
        <td>{patient.county}</td>
        <button onClick={() => onDeleteClick(patient)}value="eliminar">ELIMINAR</button>
        </tr>
      </div>  
      )
    };
    
    export default Patient;
    
    
    
   
import React, { useState } from 'react';
import { PatientCollection } from '../../api/Collections/PatientCollection';
import { useForm } from "react-hook-form";
import {validateRut,formatRut} from 'rutlib'




const PatientForm = () => {

  //SetState and Const for parameters


  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm();

  const submit = (data) => {

    console.log(data);

   PatientCollection.insert(data); 

  };

  return (
    <div>
      <form onSubmit={handleSubmit(submit)}>
        <label htmlFor="name">First name </label>
        <input
          autoComplete="name"
          type="text"
          placeholder="Nombre"
          {...register('name', { required: true })}
        />
        {errors.name && <p>Se necesita Un Nombre</p>}
        <label htmlFor="FirstLastName">Apellido Materno </label>
        <input
          type="text"
          placeholder="Apellido Paterno"
          {...register('FirstLastName', { required: true })}
        />
        {errors.FirstLastName && <p>Necesitas Un Apellido Paterno</p>}
        <label htmlFor="SecondLastName" >Apellido Materno </label>
        <input
          type="text"
          placeholder="Apellido Materno"
        />
        <label htmlFor="Rut">Rut </label>
        <input
          type="text"
          placeholder="Rut"
          {...register('Rut', { required: true ,
          validate: validateRut,
        })}
        />
        {errors.Rut && <p>Se Necesita Un Rut</p>}
        <label htmlFor="zipCode">Codigo Postal </label>
        <input
          type="text"
          placeholder="Codigo Postal"
          {...register('zipCode', { required: true })}
        />
        {errors.zipCode && <p>Se Necesita Un Codigo Postal</p>}
        <label htmlFor="state" >Region </label>
        <input
          type="text"
          placeholder="Region"
          {...register('state', { required: true })}
        />
        {errors.state && <p>Se Necesita Una Region</p>}
        <label htmlFor="county" >Comuna</label>
        <input
          type="text"
          placerholder="Comuna"
          {...register('county', { required: true })}
        />
        {errors.county && <p>Se Necesita Una Comuna</p> }
        <button type="submit" >enviar</button>
      </form>
    </div>
  );
};

export default PatientForm;


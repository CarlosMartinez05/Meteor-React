import React, { useState } from 'react';
import { PatientCollection } from '../../api/Collections/PatientCollection';
import { useForm } from "react-hook-form";

const PatientForm = () => {

  //SetState and Const for parameters
  const [name, setName] = useState("");
  const [FirstLastName, setFirstLastName] = useState("");
  const [SecondLastName, setSecondLastName] = useState("");
  const [Rut, setRut] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [state, setState] = useState("");
  const [county, setCounty] = useState("");


  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm();

  const submit = async (data) => {

    await data.preventDefault;

    if (!Rut) return;

    PatientCollection.insert({
      name, FirstLastName, SecondLastName, Rut, zipCode, state, county,
    });

    setName("");
    setFirstLastName("")
    setSecondLastName("")
    setRut("")
    setZipCode("")
    setState("")
    setCounty("")
  };

  return (
    <div>
      <form onSubmit={handleSubmit(submit)}>
        <label htmlFor="name">First name </label>
        <input
          autoComplete="name"
          type="text"
          placeholder="Nombre"
          value={name}
          {...register('name', { required: true })}
          onChange={(e) => setName(e.target.value)}
        />
        {errors.name && <p>Se necesita Un Nombre</p>}
        <label htmlFor="FirstLastName">Apellido Materno </label>
        <input
          type="text"
          placeholder="Apellido Paterno"
          value={FirstLastName}
          {...register('FirstLastName', { required: true })}
          onChange={(e) => setFirstLastName(e.target.value)}
        />
        {errors.FirstLastName && <p>Necesitas Un Apellido Paterno</p>}
        <label htmlFor="SecondLastName" >Apellido Materno </label>
        <input
          type="text"
          placeholder="Apellido Materno"
          value={SecondLastName}
          onChange={(e) => setSecondLastName(e.target.value)}
        />
        <label htmlFor="Rut">Rut </label>
        <input
          type="text"
          placeholder="Rut"
          value={Rut}
          {...register('Rut', { required: true })}
          onChange={(e) => setRut(e.target.value)}
        />
        {errors.Rut && <p>Se Necesita Un Rut</p>}
        <label htmlFor="zipCode">Codigo Postal </label>
        <input
          type="text"
          placeholder="Codigo Postal"
          value={zipCode}
          {...register('zipCode', { required: true })}
          onChange={(e) => setZipCode(e.target.value)}
        />
        {errors.zipCode && <p>Se Necesita Un Codigo Postal</p>}
        <label htmlFor="state" >Region </label>
        <input
          type="text"
          placeholder="Region"
          value={state}
          {...register('state', { required: true })}
          onChange={(e) => setState(e.target.value)}
        />
        {errors.state && <p>Se Necesita Una Region</p>}
        <label htmlFor="county" >Comuna</label>
        <input
          type="text"
          placerholder="Comuna"
          value={county}
          {...register('county', { required: true })}
          onChange={(e) => setCounty(e.target.value)}
        />
        {errors.county && <p>Se Necesita Una Comuna</p> }
        <button type="submit" >enviar</button>
      </form>
    </div>
  );
};

export default PatientForm;


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
    <div className='md:container px-10 py-4 bg-slate-300'>
      <form onSubmit={handleSubmit(submit)}>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">First name </label>
        <input
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          autoComplete="name"
          type="text"
          placeholder="Type to Name"
          value={name}
          {...register('name', { required: true })}
          onChange={(e) => setName(e.target.value)}
        />
        {errors.name && <p>Se necesita Un Nombre</p>}
        <label htmlFor="FirstLastName" className="block text-sm font-medium text-gray-700">Apellido Materno </label>
        <input
          className="mt-1 block w-full rounded-md border-blue-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          type="text"
          placeholder="Type firstLastName"
          value={FirstLastName}
          {...register('FirstLastName', { required: true })}
          onChange={(e) => setFirstLastName(e.target.value)}
        />
        {errors.FirstLastName && <p>Necesitas Un Apellido Paterno</p>}
        <label htmlFor="SecondLastName" className="block text-sm font-medium text-gray-700">Apellido Materno </label>
        <input
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          type="text"
          placeholder="Type Second Last Name"
          value={SecondLastName}
          onChange={(e) => setSecondLastName(e.target.value)}
        />
        <label htmlFor="Rut" className="block text-sm font-medium text-gray-700">Rut </label>
        <input
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          type="text"
          placeholder="Type to rut"
          value={Rut}
          {...register('Rut', { required: true })}
          onChange={(e) => setRut(e.target.value)}
        />
        {errors.Rut && <p>Se Necesita Un Rut</p>}
        <label htmlFor="zipCode" className="block text-sm font-medium text-gray-700">Codigo Postal </label>
        <input
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          type="text"
          placeholder="Type to zip code"
          value={zipCode}
          {...register('zipCode', { required: true })}
          onChange={(e) => setZipCode(e.target.value)}
        />
        {errors.zipCode && <p>Se Necesita Un Codigo Postal</p>}
        <label htmlFor="state" className="block text-sm font-medium text-gray-700">Region </label>
        <input
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          type="text"
          placeholder="Select Your State"
          value={state}
          {...register('state', { required: true })}
          onChange={(e) => setState(e.target.value)}
        />
        {errors.state && <p>Se Necesita Una Region</p>}
        <label htmlFor="county" className="block text-sm font-medium text-gray-700">Comuna </label>
        <input
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          type="text"
          placerholder="Select Your County"
          value={county}
          {...register('county', { required: true })}
          onChange={(e) => setCounty(e.target.value)}
        />
        {errors.county && <p>Se Necesita Una Comuna</p>}

        <button type="submit"  className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">enviar</button>
      </form>
    </div>
  );
};

export default PatientForm;


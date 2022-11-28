module.export({LinksCollection:()=>LinksCollection},true);let Mongo;module.link('meteor/mongo',{Mongo(v){Mongo=v}},0);

const LinksCollection = new Mongo.Collection('links');

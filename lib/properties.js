'use strict';
const Hoek = require('hoek');
const Utilities = require('../lib/utilities');

const internals = {};

exports = module.exports = internals.properties = function (settings) {

    this.settings = settings;

    // swagger type can be "string", "number", "integer", "boolean", "array" or "file"
    this.simpleTypePropertyMap = {
        'boolean': { 'type': 'boolean' },
        'binary': { 'type': 'string', 'format': 'binary' },
        'date': { 'type': 'string', 'format': 'date' },
        'number': { 'type': 'number' },
        'string': { 'type': 'string' }
    };

    this.complexTypePropertyMap = {
        'any': { 'type': 'string' },
        'array': { 'type': 'array' },
        'func': { 'type': 'string' },
        'object': { 'type': 'object' },
        'alternatives': { 'type': 'alternatives' }
    };

    // merge
    this.propertyMap = Hoek.applyToDefaults(this.simpleTypePropertyMap, this.complexTypePropertyMap);
};



/**
 * builds a swagger parameters object from a JOI object
 *
 * @param  {Object} joiObj
 * @param  {String} type
 * @param  {Array} definitionCollection
 * @return {Object}
 */
internals.properties.prototype.toParameters = function (joiObj, definitionCollection, altDefinitionCollection, type, isAlt) {

    const propertyObj = this.parseProperties(joiObj, definitionCollection, altDefinitionCollection, type, isAlt);
    const keys = Object.keys(propertyObj);
    let out = [];
    // object to array
    keys.forEach( (element, index) => {

        let key = keys[index];
        let item = propertyObj[key];
        item.name = key;
        if (type) {
            item.in = type;
        }
        out.push(item);

    });
    return out;
};


/**
 * parse Joi validators object into an object of swagger properties
 *
 * @param  {Object || Array} joiObj
 * @param  {Object} definitionCollection
 * @param  {Object} altDefinitionCollection
 * @param  {String} type
 * @return {Object}
 */
internals.properties.prototype.parseProperties = function (joiObj, definitionCollection, altDefinitionCollection, type, isAlt) {

    let propertiesObj = {};

    if (!Utilities.isJoi(joiObj) && !Array.isArray(joiObj)){
        return {};
    }

    // if an object is pass get its array of child items
    if (Utilities.hasJoiChildren(joiObj)) {
        joiObj = joiObj._inner.children;
    }

    if (Array.isArray(joiObj)){
        joiObj.forEach( (obj) => {

            let name = obj.key;
            let definitionName = name;
            let joiChildObj = obj.schema;
            // get name form label if set
            if ( Utilities.geJoiLabel( joiChildObj ) ) {
                definitionName = Utilities.geJoiLabel( joiChildObj );
            }


            propertiesObj[name] = this.parseProperty(definitionName, joiChildObj, definitionCollection, altDefinitionCollection, type, isAlt);
        });
    }

    return Utilities.deleteEmptyProperties(propertiesObj);
};


/**
 * turns JOI object into an array
 * needed to covert custom parameters objects passed in by plug-in route options
 *
 * @param  {Object} obj
 * @return {Array}
 */
internals.properties.prototype.joiObjectToArray = function (obj) {

    let out = [];
    for (let key in obj) {
        out.push({
            key: key,
            schema: obj[key]
        });
    }
    return out;
};

/**
 * parse Joi validators object into a swagger property
 *
 * @param  {String} name
 * @param  {Object} joiObj
 * @param  {Object} definitionCollection
 * @param  {Object} altDefinitionCollection
 * @param  {String} type
 * @param  {Boolean} isAlt
 * @return {Object}
 */
internals.properties.prototype.parseProperty = function (name, joiObj, definitionCollection, altDefinitionCollection, type, isAlt) {

    let property = { type: 'void' };

    // if wrong format or forbidden - return undefined
    if (!Utilities.isJoi(joiObj)){
        return undefined;
    }
    if (Hoek.reach(joiObj, '_flags.presence') === 'forbidden') {
        return undefined;
    }

    // add correct type and format by mapping
    let joiType = joiObj._type.toLowerCase();
    let map = this.propertyMap[ joiType ];
    property.type = map.type;
    if ( map.format ){
        property.format = map.format;
    }

    property = this.parsePropertyMetadata(property, joiObj);

    // add enum
    let describe = joiObj.describe();
    if (Array.isArray(describe.valids) && describe.valids.length) {
        // fliter out empty values and arrays
        var enums = describe.valids.filter( (item) => {

            return item !== '' && item !== null;
        });
        if (enums.length > 0) {
            property.enum = enums;
        }
    }

    // add number properties
    if (property.type === 'string') {
        property = this.parseString(property, joiObj);
    }

    // add number properties
    if (property.type === 'number') {
        property = this.parseNumber(property, joiObj);
    }

    // add object child properties
    if (property.type === 'object') {
        if (Utilities.hasJoiChildren(joiObj)) {
            property = this.parseObject(property, joiObj, name, definitionCollection, altDefinitionCollection, isAlt);
        } else {
            // TODO add system wide logging system for schema errors
            //let errObj = Joi.object().keys({ 'Error_no_child_properties_defined_for_object': Joi.string() });
            //property = internals.parseObject(property, errObj, name, definitionCollection, altDefinitionCollection, isAlt);
        }
    }

    // add array properties
    if (property.type === 'array') {
        property = this.parseArray(property, joiObj, name, definitionCollection, altDefinitionCollection, type, isAlt);
    }


    // add alternatives properties
    if (property.type === 'alternatives') {
        property = this.parseAlternatives(property, joiObj, name, definitionCollection, altDefinitionCollection, type);
    }

    // convert property to file upload, if indicated by meta property
    if (Utilities.getJoiMetaProperty(joiObj, 'swaggerType') === 'file') {
        property.type = 'file';
        property.in = 'formData';
    }

    return Utilities.deleteEmptyProperties(property);
};


/**
 * parse property metadata
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @return {Object}
 */
internals.properties.prototype.parsePropertyMetadata = function (property, joiObj) {

    const describe = joiObj.describe();

    // add common properties
    property.description = Hoek.reach(joiObj, '_description');
    property.notes = Hoek.reach(joiObj, '_notes');
    property.tags = Hoek.reach(joiObj, '_tags');

    // add extended properties not part of openAPI spec
    if (this.settings.xProperties === true) {
        internals.convertRules(property, describe.rules, [
            'unit'
        ], 'x-format');
        property['x-example'] = Hoek.reach(joiObj, '_examples.0');
        property['x-meta'] = Hoek.reach(joiObj, '_meta.0');
    }

    // add required state only if true
    if (Hoek.reach(joiObj, '_flags.presence')) {
        property.required = (Hoek.reach(joiObj, '_flags.presence') === 'required') ? true : undefined;
        if (Hoek.reach(joiObj, '_flags.presence') === 'optional') {
            property.required = false;
        }
    }

    property.default = Hoek.reach(joiObj, '_flags.default');

    // allow for function calls
    if (Utilities.isFunction(property.default)) {
        property.default = property.default();
    }

    return property;
};


/**
 * parse string property
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @return {Object}
 */
internals.properties.prototype.parseString = function (property, joiObj) {

    const describe = joiObj.describe();

    property.minLength = internals.getArgByName(describe.rules, 'min');
    property.maxLength = internals.getArgByName(describe.rules, 'max');

    // add regex
    joiObj._tests.forEach((test) => {
        if (Utilities.isRegex(test.arg)) {
            property.pattern = test.arg.toString();
        }
    });


    // add extended properties not part of openAPI spec
    if (this.settings.xProperties === true) {
        internals.convertRules(property, describe.rules, [
            'insensitive',
            'length'
        ], 'x-constraint');

        internals.convertRules(property, describe.rules, [
            'creditCard',
            'alphanum',
            'token',
            'email',
            'ip',
            'uri',
            'guid',
            'hex',
            'hostname',
            'isoDate'
        ], 'x-format');

        internals.convertRules(property, describe.rules, [
            'lowercase',
            'uppercase',
            'trim'
        ], 'x-convert');
    }

    return property;
};


/**
 * parse number property
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @return {Object}
 */
internals.properties.prototype.parseNumber = function (property, joiObj) {

    const describe = joiObj.describe();
    property.minimum = internals.getArgByName(describe.rules, 'min');
    property.maximum = internals.getArgByName(describe.rules, 'max');
    if (internals.hasPropertyByName(describe.rules, 'integer')) {
        property.type = 'integer';
    }

    // add extended properties not part of openAPI spec
    if (this.settings.xProperties === true) {
        internals.convertRules(property, describe.rules, [
            'greater',
            'less',
            'precision',
            'multiple',
            'positive',
            'negative'
        ], 'x-constraint');
    }

    return property;
};


/**
 * parse object property
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @param  {String} name
 * @param  {Object} definitionCollection
 * @param  {Object} altDefinitionCollection
 * @return {Object}
 */
internals.properties.prototype.parseObject = function (property, joiObj, name, definitionCollection, altDefinitionCollection, isAlt) {

    joiObj = joiObj._inner.children;
    property.name = name;
    property.type = 'object';
    if (name) {
        const LocalDefinitions = require('../lib/definitions');
        const localDefinitions = new LocalDefinitions(this.settings);
        if (isAlt === true && this.settings.xProperties === true) {
            property.schema = {
                '$ref': '#/x-alt-definitions/' + localDefinitions.appendJoi(name, joiObj, definitionCollection, altDefinitionCollection, null, true)
            };
        }
        if (!isAlt) {
            property.schema = {
                '$ref': '#/definitions/' + localDefinitions.appendJoi(name, joiObj, definitionCollection, altDefinitionCollection, null, false)
            };
        }
    } else {
        property.properties = this.parseProperties(joiObj, definitionCollection, altDefinitionCollection);
    }

    return property;
};


/**
 * parse array property
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @param  {String} name
 * @param  {Object} definitionCollection
 * @param  {Object} altDefinitionCollection
 * @param  {String} type
 * @return {Object}
 */
internals.properties.prototype.parseArray = function (property, joiObj, name, definitionCollection, altDefinitionCollection, type, isAlt) {

    const describe = joiObj.describe();
    property.minItems = internals.getArgByName(describe.rules, 'min');
    property.maxItems = internals.getArgByName(describe.rules, 'max');


    // add extended properties not part of openAPI spec
    if (this.settings.xProperties === true) {
        internals.convertRules(property, describe.rules, [
            'length',
            'unique'
        ], 'x-constraint');

        if (describe.flags.sparse) {
            internals.addToPropertyObject(property, 'x-constraint', 'sparse', true);
        }
        if (describe.flags.single) {
            internals.addToPropertyObject(property, 'x-constraint', 'single', true);
        }
    }


    // default the items with type:string
    property.items = {
        'type': 'string'
    };

    // set swaggers collectionFormat to one that works with hapi
    if (type === 'query' || type === 'formData') {
        property.collectionFormat = 'multi';
    }

    // swagger appears to only support one array type at a time, so grab the first one
    let arrayTypes = joiObj._inner.items; // joiObj._inner.inclusions;
    let foundArray = Utilities.first(arrayTypes);

    if (foundArray) {
        // get name of embeded array
        if ( Utilities.geJoiLabel( foundArray )) {
            name =  Utilities.geJoiLabel( foundArray );
        }

        let arrayProperty = this.parseProperty(name, foundArray, definitionCollection, altDefinitionCollection, null, isAlt);
        if (this.simpleTypePropertyMap[foundArray._type.toLowerCase()]) {
            // map simple types directly
            property.items = {
                'type': arrayProperty.type
            };
            if (arrayProperty.format) {
                property.items.format = arrayProperty.format;
            }
        } else {
            property.items = arrayProperty.schema;
        }
    }

    // array has to have a type default it to string
    if (!property.items) {
        property.items = { 'type': 'string' };
    }

    return property;
};


/**
 * parse alternatives property
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @param  {String} name
 * @param  {Object} definitionCollection
 * @param  {Object} altDefinitionCollection
 * @param  {String} type
 * @return {Object}
 */
internals.properties.prototype.parseAlternatives = function (property, joiObj, name, definitionCollection, altDefinitionCollection, type) {

    // convert .try() alternatives structures
    if (Hoek.reach(joiObj, '_inner.matches.0.schema')) {
        // add first into definitionCollection
        let child = joiObj._inner.matches[0].schema;
        let childName = Utilities.geJoiLabel(joiObj);
        property = this.parseProperty(childName, child, definitionCollection, altDefinitionCollection, type, false);

        // create the alternatives without appending to the definitionCollection
        if (this.settings.xProperties === true) {
            let altArray = joiObj._inner.matches.map((obj) => {
                let altName = (Utilities.geJoiLabel(obj.schema) || name);
                return this.parseProperty(altName, obj.schema, definitionCollection, altDefinitionCollection, type, true);
            });
            property['x-alternatives'] = Hoek.clone(altArray);
        }
    }

    // convert .when() alternatives structures
    else {
        // add first into definitionCollection
        let child = joiObj._inner.matches[0].then;
        let childName = (Utilities.geJoiLabel(child) || name) + 'y';
        property = this.parseProperty(childName, child, definitionCollection, altDefinitionCollection, type, false);

        // create the alternatives without appending to the definitionCollection
        if (this.settings.xProperties === true) {
            let altArray = joiObj._inner.matches
                .reduce((res, obj) => {
                    obj.then && res.push(obj.then);
                    obj.otherwise && res.push(obj.otherwise);
                    return res;
                }, [])
                .map((joiNewObj) => {
                    let altName = (Utilities.geJoiLabel(joiNewObj) || name);
                    return this.parseProperty(altName, joiNewObj, definitionCollection, altDefinitionCollection, type, true);
                })
                .filter((obj) => obj);
            property['x-alternatives'] = Hoek.clone(altArray);
        }
    }

    if (Utilities.geJoiLabel(joiObj)) {
        property.name = Utilities.geJoiLabel(joiObj);
    }


    return property;
};


/**
 * coverts rules into property objects
 *
 * @param  {Object} property
 * @param  {Array} rules
 * @param  {Array} ruleNames
 * @param  {String} groupName
 */
internals.convertRules = function (property, rules, ruleNames, groupName) {

    ruleNames.forEach((ruleName) => {
        internals.appendToPropertyObject(property, rules, groupName, ruleName);
    });
};


/**
 * appends a name item to object on a property
 *
 * @param  {Object} property
 * @param  {Array} rules
 * @param  {String} groupName
 * @param  {String} ruleName
 */
internals.appendToPropertyObject = function (property, rules, groupName, ruleName) {

    if (internals.hasPropertyByName(rules, ruleName)) {
        let value = internals.getArgByName(rules, ruleName);
        if (Utilities.isObject(value) && Utilities.hasProperties(value) === false) {
            value = undefined;
        }
        internals.addToPropertyObject(property, groupName, ruleName, value);
    }
};


internals.addToPropertyObject = function (property, groupName, ruleName, value) {

    if (!property[groupName]) {
        property[groupName] = {};
    }
    property[groupName][ruleName] = (value) ? value : true;
};


/**
 * return the value of an item in array of object by name - structure [ { name: 'value', arg: 'value' } ]
 *
 * @param  {Array} array
 * @param  {String} name
 * @return {String || Undefined}
 */
internals.getArgByName = function (array, name) {

    if (Array.isArray(array)) {
        let i = array.length;
        while (i--) {
            if (array[i].name === name) {
                return array[i].arg;
            }
        }
    }
    return undefined;
};


/**
 * return existance of an item in array of - structure [ { name: 'value' } ]
 *
 * @param  {Array} array
 * @param  {String} name
 * @return {Boolean}
 */
internals.hasPropertyByName = function (array, name) {

    return array && array.some((obj) => {

        return obj.name === name;
    });
};

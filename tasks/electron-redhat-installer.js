'use strict';

var _ = require('lodash');
var asar = require('asar');
var async = require('async');
var child = require('child_process');
var fs = require('fs-extra');
var glob = require('glob');
var path = require('path');
var temp = require('temp').track();
var wrap = require('word-wrap');

/**
 * Spawn a child process.
 */
var spawn = function (command, args, callback) {
  var spawnedProcess = null;
  var error = null;
  var stderr = '';

  try {
    spawnedProcess = child.spawn(command, args);
  }
  catch (err) {
    process.nextTick(function () {
      callback(err, stderr);
    });
    return;
  }

  spawnedProcess.stderr.on('data', function (data) {
    stderr += data;
  });

  spawnedProcess.on('error', function (err) {
    error = error || err;
  });

  spawnedProcess.on('close', function (code, signal) {
    if (code !== 0) {
      error = error || signal || code;
    }

    callback(error && new Error('Error executing command (' + (error.message || error) + '): ' +
      '\n' + command + ' ' + args.join(' ') + '\n' + stderr));
  });
};

/**
 * Read `package.json` either from `resources.app.asar` (if the app is packaged)
 * or from `resources/app/package.json` (if it is not).
 */
var readPackage = function (options, callback) {
  var withAsar = path.join(options.src, 'resources/app.asar');
  var withoutAsar = path.join(options.src, 'resources/app/package.json');

  try {
    if (fs.existsSync(withAsar)) {
      callback(null, JSON.parse(asar.extractFile(withAsar, 'package.json')));
    }
    else {
      callback(null, fs.readJsonSync(withoutAsar));
    }
  }
  catch (err) {
    callback(new Error('Error reading package: ' + (err.message || err)));
  }
};

/**
 * Read `LICENSE` from the root of the app.
 */
var readLicense = function (options, callback) {
  fs.readFile(path.join(options.src, 'LICENSE'), callback);
};

/**
 * Get the hash of default options for the Grunt task. Some come from the info
 * read from `package.json`, and some are hardcoded.
 */
var getDefaults = function (task, callback) {
  readPackage({src: task.data.src}, function (err, pkg) {
    pkg = pkg || {};

    var defaults = {
      name: pkg.name || 'electron',
      productName: pkg.productName || pkg.name,
      genericName: pkg.genericName || pkg.productName || pkg.name,
      description: pkg.description,
      productDescription: pkg.productDescription || pkg.description,
      version: pkg.version || '0.0.0',
      revision: pkg.revision || '1',
      license: pkg.license,

      arch: undefined,

      requires: [
        'lsb'
      ],

      homepage: pkg.homepage || (pkg.author && (typeof pkg.author === 'string' ?
        pkg.author.replace(/.*\(([^)]+)\).*/, '$1') :
        pkg.author.url
      )),

      bin: pkg.name || 'electron',
      icon: path.resolve(__dirname, '../resources/icon.png'),

      categories: [
        'GNOME',
        'GTK',
        'Utility'
      ],

      rename: function (dest, src) {
        return dest + src;
      }
    };

    callback(err, defaults);
  });
};

/**
 * Get the hash of options for the Grunt task.
 */
var getOptions = function (task, defaults, callback) {
  var options = task.options(defaults);

  // Put `src` and `dest` in `options` to make it easier to pass them around.
  options.src = task.data.src;
  options.dest = task.data.dest;

  // Wrap the extended description to avoid rpmlint warning about
  // `description-line-too-long`.
  options.productDescription = wrap(options.productDescription, {width: 100, indent: ''});

  callback(null, options);
};

/**
 * Fill in a template with the hash of options.
 */
var generateTemplate = function (file, options, callback) {
  async.waterfall([
    async.apply(fs.readFile, file),
    function (template, callback) {
      callback(null, _.template(template)(options));
    }
  ], callback);
};

/**
 * Create the spec file for the package.
 *
 * See: https://fedoraproject.org/wiki/How_to_create_an_RPM_package
 */
var createSpec = function (options, dir, callback) {
  var specSrc = path.resolve(__dirname, '../resources/spec.ejs');
  var specDest = path.join(dir, 'SPECS', options.name + '.spec');

  async.waterfall([
    async.apply(generateTemplate, specSrc, options),
    async.apply(fs.outputFile, specDest)
  ], function (err) {
    callback(err && new Error('Error creating spec file: ' + (err.message || err)));
  });
};

/**
 * Create the binary for the package.
 */
var createBinary = function (options, dir, callback) {
  var binDir = path.join(dir, 'BUILD/usr/bin');
  var binSrc = path.join('../share', options.name, options.bin);
  var binDest = path.join(binDir, options.name);

  async.waterfall([
    async.apply(fs.ensureDir, binDir),
    async.apply(fs.symlink, binSrc, binDest, 'file')
  ], function (err) {
    callback(err && new Error('Error creating binary file: ' + (err.message || err)));
  });
};

/**
 * Create the desktop file for the package.
 *
 * See: http://standards.freedesktop.org/desktop-entry-spec/latest/
 */
var createDesktop = function (options, dir, callback) {
  var desktopSrc = path.resolve(__dirname, '../resources/desktop.ejs');
  var desktopDest = path.join(dir, 'BUILD/usr/share/applications', options.name + '.desktop');

  async.waterfall([
    async.apply(generateTemplate, desktopSrc, options),
    async.apply(fs.outputFile, desktopDest)
  ], function (err) {
    callback(err && new Error('Error creating desktop file: ' + (err.message || err)));
  });
};

/**
 * Create icon for the package.
 */
var createIcon = function (options, dir, callback) {
  var iconFile = path.join(dir, 'BUILD/usr/share/pixmaps', options.name + '.png');

  fs.copy(options.icon, iconFile, function (err) {
    callback(err && new Error('Error creating icon file: ' + (err.message || err)));
  });
};

/**
 * Create copyright for the package.
 */
var createCopyright = function (options, dir, callback) {
  var copyrightFile = path.join(dir, 'BUILD/usr/share/doc', options.name, 'copyright');

  async.waterfall([
    async.apply(readLicense, options),
    async.apply(fs.outputFile, copyrightFile)
  ], function (err) {
    callback(err && new Error('Error creating copyright file: ' + (err.message || err)));
  });
};

/**
 * Copy the application into the package.
 */
var createApplication = function (options, dir, callback) {
  var applicationDir = path.join(dir, 'BUILD/usr/share', options.name);

  async.waterfall([
    async.apply(fs.ensureDir, applicationDir),
    async.apply(fs.copy, options.src, applicationDir)
  ], function (err) {
    callback(err && new Error('Error copying application directory: ' + (err.message || err)));
  });
};

/**
 * Create temporary directory where the contents of the package will live.
 */
var createDir = function (options, callback) {
  async.waterfall([
    async.apply(temp.mkdir, 'electron-'),
    function (dir, callback) {
      dir = path.join(dir, options.name + '_' + options.version + '_' + options.arch);
      fs.ensureDir(dir, callback);
    }
  ], function (err, dir) {
    callback(err && new Error('Error creating temporary directory: ' + (err.message || err)), dir);
  });
};

/**
 * Create macros file used by `rpmbuild`.
 */
var createMacros = function (options, dir, callback) {
  var macrosSrc = path.resolve(__dirname, '../resources/macros.ejs');
  var macrosDest = path.join(process.env.HOME, '.rpmmacros');

  async.waterfall([
    async.apply(generateTemplate, macrosSrc, _.assign({dir: dir}, options)),
    async.apply(fs.outputFile, macrosDest)
  ], function (err) {
    callback(err && new Error('Error creating macros file: ' + (err.message || err)), dir);
  });
};

/**
 * Create the contents of the package.
 */
var createContents = function (options, dir, callback) {
  async.parallel([
    async.apply(createSpec, options, dir),
    async.apply(createBinary, options, dir),
    async.apply(createDesktop, options, dir),
    async.apply(createIcon, options, dir),
    async.apply(createCopyright, options, dir),
    async.apply(createApplication, options, dir)
  ], function (err) {
    callback(err, dir);
  });
};

/**
 * Package everything using `rpmbuild`.
 */
var createPackage = function (options, dir, callback) {
  var specFile = path.join(dir, 'SPECS', options.name + '.spec');
  spawn('rpmbuild', ['-bb', specFile, '--target', options.arch], function (err) {
    callback(err, dir);
  });
};

/**
 * Move the package to the specified destination.
 */
var movePackage = function (options, dir, callback) {
  var packagePattern = path.join(dir, 'RPMS', options.arch, '*.rpm');

  async.waterfall([
    async.apply(glob, packagePattern),
    function (files, callback) {
      async.each(files, function (file) {
        var dest = options.rename(options.dest, path.basename(file));
        fs.move(file, _.template(dest)(options), {clobber: true}, callback);
      }, callback);
    }
  ], function (err) {
    callback(err && new Error('Error moving package files: ' + (err.message || err)), dir);
  });
};

/******************************************************************************/

module.exports = function (grunt) {
  grunt.registerMultiTask('electron-redhat-installer',
                          'Create a Red Hat package for your Electron app.', function () {
    var done = this.async();

    grunt.log.writeln('Creating package (this may take a while)');

    async.waterfall([
      async.apply(getDefaults, this),
      async.apply(getOptions, this),
      function (options, callback) {
        async.waterfall([
          async.apply(createDir, options),
          async.apply(createMacros, options),
          async.apply(createContents, options),
          async.apply(createPackage, options),
          async.apply(movePackage, options)
        ], function (err) {
          callback(err, options);
        });
      }
    ], function (err, options) {
      if (!err) {
        grunt.log.ok('Successfully created package ' + options.dest);
      }

      done(err);
    });
  });
};

/**
 * @author Alan Ross
 * @version 0.1
 */

function JacquardController()
{
    // Note: UUIDs must be lowercase
    const UUID_JACQUARD_SERVICE = "d45c2000-4270-a125-a25d-ee458c085001";
    const UUID_JACQUARD_ANALOG = "d45c2010-4270-a125-a25d-ee458c085001";
    const UUID_JACQUARD_LED_PATTERN = "d45c2080-4270-a125-a25d-ee458c085001";
    const UUID_JACQUARD_GESTURE = "d45c2030-4270-a125-a25d-ee458c085001";

    const decode = [0, 1, 2, 4, 8, 16, 32, 64, 128, 192, 224, 240, 248, 252, 254, 255];

    let _lastLines = null;
    let _lastIndex = 0;
    let _unchanged = null;

    let _device = null;
    let _service = null;
    let _ledPatternCharacteristic = null;
    let _analogCharacteristic = null;

    let _analogBuffer;
    let _analogOut = null;
    let _analogTid = 0;

    /**
     * Connect to a Google Jacquard jacket via Web Bluetooth.
     *
     * @returns promise
     * @public
     */
    function connect()
    {
        _device = null;
        _service = null;
        _ledPatternCharacteristic = null;
        _analogCharacteristic = null;

        let options = {
            filters: [{ name: 'Jacquard' }],
            optionalServices: [UUID_JACQUARD_SERVICE]
        };

        return navigator.bluetooth.requestDevice( options )
            .then( function( device )
            {
                _device = device;
                _device.addEventListener( 'gattserverdisconnected', onServerDisconnected );

                return _device.gatt.connect();
            } )
            .then( function( server )
            {
                return server.getPrimaryService( UUID_JACQUARD_SERVICE );
            } )
            .then( function( service )
            {
                _service = service;

                return _service.getCharacteristic( UUID_JACQUARD_LED_PATTERN );
            } )
            .then( characteristic =>
            {
                _ledPatternCharacteristic = characteristic;

                return _service.getCharacteristic( UUID_JACQUARD_ANALOG );
            } )
            .then( function( characteristic )
            {
                _analogCharacteristic = characteristic;

                return attachAnalogDataListener( onAnalogData );
            } );
    }

    /**
     * Request the jacket to display a animated LED light pattern.
     *
     * @param {byte} type - Type of pattern, from 0x0 - 0x21
     * @param {byte} duration - Duration the pattern will be displayed, from 0x0 - 0xFF
     * @param {byte} brightness - Brightness of the LEDs, from 0x0 - 0xFF
     * @returns promise
     * @public
     */
    function setLEDPattern( type, duration, brightness )
    {
        if( _ledPatternCharacteristic == null )
        {
            throw new Error( "No connection to the jacket." );
        }

        type = type || 0x10;
        duration = duration || 0x08;
        brightness = brightness || 0xFF;

        const payload = new Int8Array( [type, duration, brightness] );

        return _ledPatternCharacteristic.writeValue( payload );
    }

    function onServerDisconnected()
    {
        _device.removeEventListener( 'gattserverdisconnected', onServerDisconnected );
        _device = null;
        _service = null;
        _ledPatternCharacteristic = null;
        _analogCharacteristic = null;

        _onDisconnected()
    }

    /**
     * Request to get notification when new analog data is received.
     *
     * @returns promise
     * @private
     */
    function attachAnalogDataListener( callBack )
    {
        if( _analogCharacteristic == null )
        {
            throw new Error( "No connection to the jacket." );
        }

        _lastIndex = 0;
        _lastLines = new Int8Array( 15 ).fill( 0 );
        _unchanged = new Array( 15 ).fill( 0 );
        _analogOut = { proximity: 0, lines: new Array( 15 ).fill( 0 ) };

        _analogCharacteristic.addEventListener( 'characteristicvaluechanged', callBack );

        return _analogCharacteristic.startNotifications();
    }

    /**
     * Process the data received from the jacket.
     *
     * @param event
     * @private
     */
    function onAnalogData( event )
    {
        // In Chrome 50+, a DataView is returned instead of an ArrayBuffer.
        const v = event.target.value;
        const data = v.buffer ? new Int8Array( v.buffer ) : new Int8Array( v );

        // data : [ 0, 1,    2, ... 9,    10, ... 17 ]
        // parts:   index,  compressed1,  compressed2

        const index = (data[0] & 0xFF) | (data[1] << 8);

        if( index == 0 )
        {
            _lastIndex = index;

            processBuffer( _analogBuffer = new Int8Array( data.buffer, 2, 16 ) );
        }
        else if( index == _lastIndex + 2 )
        {
            _lastIndex = index;

            unpackData( data.slice( 2, 10 ), _analogBuffer );
            processBuffer( _analogBuffer );

            unpackData( data.slice( 10, 18 ), _analogBuffer );
            processBuffer( _analogBuffer );
        }
        else if( _analogBuffer != null )
        {
            processBuffer( _analogBuffer );
        }
    }

    /**
     * Decompress given data.
     *
     * @param {Int8Array} input - Compressed input in a byte array
     * @param {Int8Array} output - Uncompressed data
     * @private
     */
    function unpackData( input, output )
    {
        for( let i = 0; i < input.length; i++ )
        {
            let j = i * 2;
            output[j] = ( output[j] + (decode[(input[i] >> 4) & 0x0F] & 0xFF) );

            j++;
            output[j] = ( output[j] + (decode[input[i] & 0x0F] & 0xFF) );
        }
    }

    /**
     * Process byte array containing analog data.
     *
     * @param {Int8Array} data - Byte array containing analog data
     * @private
     */
    function processBuffer( data )
    {
        _analogOut.proximity = data[0];
        _analogOut.lines.fill( 0 );

        let lines = data.slice( 1, data.length );

        for( let i = 0; i < lines.length; i++ )
        {
            let val = Math.min( lines[i] & 0xFF, 0x80 );

            if( lines[i] == _lastLines[i] )
            {
                _unchanged[i]++;

                if( val < 0x80 || _unchanged[i] >= 10 )
                {
                    let n = _unchanged[i];

                    val = Math.max( Math.floor( val - n * n * 0.025 ), 0 );
                }
            }
            else
            {
                _unchanged[i] = 0;
            }

            _analogOut.lines[i] = val;
        }

        _lastLines = lines;

        _onAnalogInput( _analogOut );

        clearTimeout( _analogTid );

        _analogTid = setTimeout( function()
        {
            _analogOut.proximity = 0;
            _analogOut.lines.fill( 0 );
            _onAnalogInput( _analogOut );
        }, 50 );
    }

    /**
     * Default callback for newly received analog data.
     *
     * @param data - Data object containing proximity and line info
     * @private
     */
    function _onAnalogInput( data )
    {
        console.log( data.proximity, data.lines.join() );
    }

    /**
     * Default callback, called when the jacked is disconnected.
     *
     * @private
     */
    function _onDisconnected()
    {
        console.log( "Jacket disconnected." );
    }

    return {
        connect: connect,
        setLEDPattern: setLEDPattern,
        onAnalogInput: function( callback )
        {
            _onAnalogInput = callback;
        },
        onDisconnected: function( callback )
        {
            _onDisconnected = callback;
        }
    }
}
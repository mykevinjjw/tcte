$(document).ready(function () 
{
    let day_time = new Date('4/26/2025')
    let  da = new Date()
    let A= Math.floor(day_time-da)
    day = A/(1000 * 3600 * 24)+1
    
    days = Math.round(day)
    // days = 
    console.log(days)
    if (days >0)
    {
        $("#day").html(days+"天");
    }
    else
    {
        $(h1).html('');
    }
  
    if (days<=10) 
    {
        $("#day").css('font-size', '23vh');
        $("#day").css('color', 'red');
        $('.public').css('top', '-5%');
    }
    }
);
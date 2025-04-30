$(document).ready(function () 
{
    let day_time = new Date('4/26/2025')
    let  da = new Date()
    if (day_time>da)
    {
        let A= Math.abs(day_time-da)
        day = Math.ceil(A/(1000 * 3600 * 24))   

        days = Math.abs(day)
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
            $("#day").css('font-size', '18vh');
            $("#day").css('color', 'red');
            // $('.public').css('top', '-20%');
        }
    }
    else
    {
        $("#h1").html('');
        // $(".h3_text").html('2025統測<br>已經過了喔!<br><a class="link" href=\'https://a2026.mykevinjj.dpdns.org\'>前往2026版</a>');
        // $('.public').css('top', '-20%');
    }
}
);